# pi-ex 功能全集与移植规格

本文档完整描述 pi-ex 相对上游 pi 的全部功能增量（插件集 + 核心修改），细到可以对照本
文档在另一个宿主（如 DeepSeek Harness）上复现。每个功能给出：行为规格、宿主挂载点、
状态与持久化、设置项、关键提示词。提示词全文以 pi-extensions 仓库内的文件为准（文中
标注路径）。

仓库布局（pi-extensions，加载方式为 `~/.pi/agent/extensions` 符号链接到本仓库根）：

```
context/        压缩管线 + prune + recall + uncertainty + 文件状态追踪 + work-loop 引导词
bash-gate/      bash 命令门（拦截与 pi 工具重复的命令）
ask-wait/       ask_user / wait 工具
todo/           todo 流（工具 + 组件 + 过期提醒 + 压缩前刷新）
bg-tasks/       tmux 后台任务
ssh/            持久 SSH 连接 + 远程执行
computer-use/   桌面自动化（grim/ydotool/wtype/hyprctl）
subagent/       进程内子代理（git worktree 隔离 + DAG + 审查合并）
codegraph-scan/ 编辑后的 codegraph 引用扫描
shared/         跨插件共享状态总线（todo-state、file-context）
test/           vitest 测试（别名指向 ../pi-ex 源码）
```

pi-ex 核心侧唯一的新机制是 `fork-host.ts` bridge（约 60 行）：以 SessionManager 实例为键
的 WeakMap，向插件暴露会话级 `streamFn` / `settingsManager` / `modelRuntime`（DSH 移植时
对应物见 §10）。

---

## 1. context 插件：上下文守护（最大的一块）

### 1.1 prune（工具输出瘦身）

- **行为**：每次 LLM 调用前（context 变换），把"旧的、庞大的只读工具输出"替换为纯元信息
  桩（stub）。规则：
  - 仅针对 read/bash/grep/find/ls 工具结果；非错误结果；不含图片；估算 ≥ 1000 token。
  - 最近 5 条**合格**（超阈值）输出永不剪（小输出/报错/图片不占保护名额）。
  - stub 全文形态：`[pruned <tool> output — ~N tok, M lines. Full output: recall with toolCallId "<id前8位>".]`
  - 幂等：已剪输出（以 `[pruned ` 开头）不再处理。多段 text part 只替换第一段、丢弃其余。
  - token 估算：CJK 感知（CJK 字符约 1 token/字，其余 ~4 字符/token）。
- **挂载点**：出站消息列表变换（每次 LLM 调用前可改消息）。pi: `context` 事件返回 `{messages}`。
- **设置**：`compaction.prune.{enabled,keepRecentToolResults=5,minPrunableTokens=1000}`。
- **源码**：`context/lib/prune.ts`（约 130 行，纯函数 `pruneContextMessages(messages, settings)`）。

### 1.2 recall（存档检索工具）

- **行为**：会话存档（append-only JSONL 树）永不删除；recall 在被压缩/剪除的内容上提供检索。
  - 参数：`query`（关键词/正则）、`files`（按涉及文件过滤）、`entryId`（精确取条目+邻居）、
    `toolCallId`（精确 id 或 ≥4 位前缀，**直接返回该工具调用的完整原始输出**——不受压缩边界、
    不受 2000 字符快照上限约束；前缀歧义时报错并列出完整 id）。
  - query/entryId 路径只搜索"已归档"区间（最近一次压缩边界之前）；toolCallId 路径搜索全分支。
  - `recall_checkpoints` 工具列出过往压缩检查点。
- **挂载点**：工具注册；只读会话树访问（getBranch/getEntries）。
- **设置**：`recall.enabled`（执行时门控）。
- **源码**：`context/lib/recall.ts`（约 360 行）。

### 1.3 压缩管线（fork compaction）

- **切点**：保留最近 `keepRecentRounds`（默认 2）个**对话轮**。轮的边界 = 用户消息 /
  bashExecution / custom / branchSummary / compactionSummary。切点永不落在轮中间（无
  split-turn）。若仅保留轮就超窗，则压不动（实践中 prune 会先瘦身）。
- **序列化全保真**：thinking 块、完整工具入参、完整工具输出——任何内容不截断。
- **预算处理**：摘要请求超窗时，从旧到新**逐轮丢弃**待压缩内容直到放下（主动估算 +
  provider 溢出拒绝时每轮重试再多丢一轮）。上轮摘要（previousSummary）承载被丢弃轮的状态。
- **触发**：`contextTokens > contextWindow * thresholdRatio`（0.9）。contextTokens 取最近一次
  未中止 assistant 消息的 provider 上报 usage。
- **结构化检查点**（`compaction.quality: "structured"`，默认）：产出四段式检查点——
  1. **Task Contract**：目标、带生命周期的约束（ACTIVE/SUPERSEDED/UNRESOLVED + 取代链）、
     用户确认的决策、未决问题。intent compiler 收到**全对话角色标记 JSON**（user 权威，
     assistant 仅作上下文且显式标记不可信）。
  2. **World State**：确定性动作台账（文件修改/命令执行/git 提交/子代理操作，无 LLM 提取）
     + 累计文件清单（L1 最近接触 / L2 外部变更）。
  3. **Execution State**：当前方法、已完成/进行中/受阻、下一步、**显式标记未验证的模型推断**、
     带来源/刷新提示的外部状态。
  4. **Verification Notes**：验证器对 contract 审计（遗漏约束、错误取代、与工具验证事实的矛盾）
     并应用修正。
  - 检查点 Markdown 进上下文；contract+ledger 以 JSON 存 `CompactionEntry.details`（`version: 2`），
    供下次压缩与 recall 消费。
  - `quality: "standard"` 回到叙事摘要；overflow 恢复强制 standard；结构化失败回退 standard。
- **挂载点**：`session_before_compact` 钩子（可返回完整自定义 CompactionResult：
  summary/firstKeptEntryId/tokensBefore/usage/details，宿主负责落盘与事件）。需要：
  会话树读、当前模型+鉴权（modelRegistry.getAuth）、会话 streamFn（bridge）、设置（bridge）。
- **设置**：`compaction.{enabled,reserveTokens=16384,keepRecentRounds=2,thresholdRatio=0.9,quality}`。
- **源码**：`context/lib/pipeline.ts`（~900 行）、`checkpoint.ts`、`contract.ts`、`ledger.ts`、
  `auto-review.ts`、`content-dedup.ts`、`summary-review.ts`、`review.ts`。
- **注意**：核心另保留 `keepRecentTokens`（默认 20000）给"未加载插件时的上游回退路径"。

### 1.4 uncertainty 协议

- **提示词注入**：每轮 before_agent_start 链式追加 `WORK_LOOP_GUIDANCE` +
  `UNCERTAINTY_PROTOCOL_PROMPT`（全文见 `context/lib/work-loop-guidance.ts` 与
  `uncertainty.ts`）。协议：模型对无法验证的推断/假设/外部状态行内标注
  `[uncertain:inference|state:<path>|question] <claim>`。
- **扫描**：assistant 消息定稿时（message_end）扫描标记入 store；edit/write 成功时按
  toolCall 的 path 标记"该文件相关条目失效"（markPathModified）。
- **意图冲突**：用户输入含 `[uncertain:xxx]` 引用时，对相关条目跑自动复审（冲突集）。
- **自动复审**（`uncertaintyReview.auto`，默认开）：压缩前与冲突后——先内容级去重
  （content-dedup，新条目优先），再上下文复审（逐条 verified/dismissed/corrected）。
  复审要推翻**用户**裁决时弹确认（5 分钟超时自动拒绝）。
- **摘要复审**：压缩摘要定稿前批量复审其中的存疑段。
- **持久化**：store 写会话自定义条目（appendCustomEntry 类写入口——注意 pi 的扩展
  sessionManager 类型是只读，运行时是完整对象，fork 约定是直接转型）。
- **设置**：`compaction.uncertaintyReview.{timing("incremental"|"at-compaction"),maxPerPrompt=5,auto=true}`。
- **源码**：`context/lib/uncertainty.ts`（~430 行）、`auto-review.ts`、`content-dedup.ts`、
  `summary-review.ts`。

### 1.5 文件状态（file-context + 陈旧否决）

- **追踪**：tool_result 事件喂养追踪器——read→markRead（内容 hash+mtime）、write/edit→
  markWritten/markEdited + uncertainty.markPathModified。L1=模型接触过的文件（LRU），
  L2=检测到外部变更的文件。
- **陈旧否决**：tool_call 拦截 write/edit——若磁盘内容与追踪视图不一致（内容 hash 比较），
  阻止执行并提示"先 read 再重试"（错误文本见 context/index.ts）。
- **file-state 通知**：用户输入时（input 事件）一次性 L1 复查（stat+hash），把外部变更以
  steer 消息注入：`[file-state] N file(s) you have seen changed on disk...`（全文见
  context/index.ts）。agent_end 时异步刷新。已通知集合去重。
- **压缩前**：refreshContacts() 刷新后快照进检查点 World State。
- **源码**：`shared/file-context.ts`（~300 行）。

## 2. bash-gate 插件

- **行为**：tool_call 拦截 bash 命令，命中"与 pi 自带工具重复"的规则即 block 并回指导文本
  （如 `cat file` → "Use the read tool"）。规则表与响应文案：`bash-gate/lib/bash-gate.ts`
  （GATE_RULES + formatGateResponse）。sleep 类命令（前导 sleep、轮询循环、watch）单独提示
  改用 bg_spawn/wait。例外：输出重定向、git 托管域名的 ssh 等。
- **挂载点**：tool_call 拦截（block + reason 返回给模型）。
- **源码**：`bash-gate/lib/bash-gate.ts`（~550 行）。

## 3. ask-wait 插件

- **ask_user**：模型回合内弹窗问用户（问题数组，逐个问，一次返回）。无 UI（headless）时
  返回固定提示："proceed with best-effort assumption + 行内 [uncertain:inference] 标注"。
  挂载点：工具注册 + UI input 对话框（`hasUI` 探测）。
- **wait**：挂起当前回合 N 秒后自动唤醒。要点：`terminate: true` 结束当前回合；计时器到点
  经 followUp（空闲）/steer（回合中）投递唤醒消息（含当前后台任务清单，读共享
  `~/.pi/agent/tasks/tasks.json`）；新回合开始/会话关闭取消待发唤醒。上限：交互 12h；
  headless 120s 且每会话 5 次。参数 clamp 模式（门转换用）。
- **源码**：`ask-wait/lib/ask-wait.ts`。

## 4. todo 插件

- **todo_write 工具**：整表替换式任务清单（content+status），模型自有条目与程序化条目分离。
- **主组件**：有界列表（in_progress→pending→done，最多 8 条 + "N more — /todo"）。**/todo 命令**
  翻页查看剩余（页大小随终端高度），翻到底关闭。
- **过期提醒**：清单 N=5 个**用户**输入未更新且有未完成项时，steer 注入提醒（提醒后重置计时）。
- **压缩前刷新**：session_before_compact 时取消压缩 → 发刷新提示（全文见 todo/index.ts 的
  TODO_COMPACTION_REMINDER）跑一个回合 → agent_end 时重新触发压缩。每个 store 状态只刷一次。
- **持久化**：会话自定义条目（"todo" 类型）。
- **源码**：`todo/lib/store.ts`（~720 行）、`todo/lib/tool.ts`、`todo/index.ts`。
- **共享总线**：`shared/todo-state.ts`——按会话的 TodoStore 单例，供 subagent 插件写进度项。

## 5. bg-tasks 插件

- **工具**：bg_spawn（tmux 新会话跑命令，返回 id+logFile）、bg_status、bg_output（日志 tail）、
  bg_kill。任务跨会话存活（进程级单例 store，`~/.pi/agent/tasks/`）。
- **通知**：任务完成时按会话路由，1 秒窗口批合成一条 followUp（含输出截断：单任务 4000 字符/
  多任务 800）。
- **命令**：/tasks（列表组件）、/fg \<id\>（输出组件）、/kill \<id\>。*/attach 留在核心*
  （tmux 终端接管需要 TUI 挂起，扩展做不到；核心读共享 tasks.json）。
- **门**：task 内 sleep >12h 报错；bash 的超长 sleep 由 bash-gate 引导至此。
- **bridge**：向宿主注册 BgSpawner（核心 bash 的 sleep→bg 转换用它——注意：当前核心该转换已删，
  门提示代替；bridge 位保留）。
- **源码**：`bg-tasks/lib/store.ts`（~960 行，tmux 封装、日志、tasks.json、恢复逻辑）。

## 6. ssh 插件

- **工具**：ssh_exec（前台=no hangup 远程跑，超时窗口后转后台监控并投递完成通知；
  background=true 直接 nohup）、ssh_status、scp_to_remote、scp_from_remote。连接为持久
  控制连接（store 管理，跨进程恢复）。
- **sudo**：命令含 sudo 且无缓存密码时——只问**用户**（masked input，内存 only），随后
  `sudo -v` 预激。/ssh sudo \<host\> 同路径。
- **tool_call 门**：bash/ssh_exec 同步超时 >300s 阻止（引导 background:true）；bash 里的
  sshpass/ssh/scp/rsync 直连阻止（git 托管域名例外）。
- **通知**：远程后台任务完成按会话批合投递（1s 窗口）。
- **源码**：`ssh/lib/store.ts`（~1600 行）、`ssh/lib/integration.ts`。

## 7. computer-use 插件

- **工具**：computer_screenshot/move/click/click_at/double_click/type/key/scroll/drag/
  get_position/get_screen_size（11 个）。后端 grim（截图）/ydotool（鼠标）/wtype（键盘）/
  hyprctl（坐标/显示器）。ydotool 需要 sudo 时探测缓存。
- **门**：仅 Hyprland/Wayland + 上述二进制存在时注册；`computerUse.enabled` 设置。
- **源码**：`computer-use/lib/integration.ts`、`geometry.ts`（坐标系换算）。

## 8. subagent 插件

- **模型**：进程内子代理，git worktree 隔离。写路径 = `.pi/subagent/<id>/` worktree +
  分支 + 自动提交 + 主代理 review/merge/reject；只读路径（readOnly）= 共享目录、机械性
  不可写、报告即交付。dependsOn DAG 编排；聚合唤醒（最后一个结束时一次性唤醒主代理）。
- **工具**：subagent_spawn/parallel/list/review/merge/reject/message/cancel/continue/followup
  （ensure_git 注册但非默认激活）。
- **运行**：子代模型循环经宿主 ModelRuntime.streamSimple（bridge 暴露）；模型解析
  `provider/id` 引用；深度/并发/超时由设置控制。
- **通知**：完成经 followUp 批合；todo 进度项经 shared/todo-state 总线写入。
- **设置**：`subagents.{enabled,maxDepth=5,maxConcurrent=5,timeout=7200,gitName,gitEmail,model}`（`model` 为 spawn 无显式覆盖时的默认模型 ref，如 `lulab/Qwen3.8-27B-FP8-DFlash2`；未设置则继承主会话模型）。
- **源码**：`subagent/lib/core/`（管理器 + worktree，~1700 行，自包含无外部依赖）、
  `manager.ts`、`runner.ts`、`tools.ts`。

## 9. codegraph-scan 插件

- **行为**：edit 工具结果后（tool_result），提取 edits 里变更的标识符，跑
  `codegraph callers <id>`（只读），把剩余调用点列表追加到编辑结果。无索引/失败静默跳过。
- **设置**：`codeScan.enabled`。
- **源码**：`codegraph-scan/lib/scan.ts`（~180 行）。

## 10. 宿主桥（fork-host，pi-ex 核心侧唯一新增机制）

扩展 API 拿不到的会话能力经 bridge 暴露（WeakMap 按 SessionManager 键控）：
- `streamFn`：会话自定义流函数（测试注入/RPC 必需）；
- `settingsManager`：fork 设置读取；
- `modelRuntime`：getModel/getProviders/streamSimple/getAuth（子代理循环与压缩摘要调用）；
- `BgSpawner` 注册位（扩展注册、核心调用）。

DSH 移植时：需要一个等价物，或确认 DSH 的插件上下文原生提供这些（见 [DSH-ANALYSIS.md](DSH-ANALYSIS.md) §2.10——结论：原生都有，bridge 可删）。

---

## 11. 留在 pi-ex 核心的修改（未随插件迁移）

| 文件 | 内容 | 备注 |
|------|------|------|
| tools/bash.ts | sudo 流程、provider 密钥环境变量剥离、超时参数体系、大输出落盘 | 工具内部行为 |
| agent-loop.ts | 并行工具批 20min 超时、MAX_LOOP_TURNS=50 防死循环、批中止 | 建议上游 PR |
| session-manager.ts | 原子写、树回退文件恢复 | — |
| settings-manager.ts | fork 设置 schema 注册 | 插件经 bridge 读 |
| file-history.ts + edit/write fileHistory 选项 | /tree 文件回退（导航时还原文件） | 与树导航耦合 |
| interactive-mode + ApplicationController | UI 中立面、选择器组件增强 | 应用本体 |
| TUI/exec/output-guard/shell 硬化 | kitty 键解析、stdin 上限、OSC8 闭合、输出上限、背压上限、密钥过滤 | 建议上游 PR |
| protocol/client/server v2 | 远程会话栈（v1 硬断） | 产品分叉，不迁 |

## 12. 迁移引入的已知行为折损（相对原核心实现）

1. sleep→wait/bg 由静默转换改为拦截+引导（tool_call 无法返回自定义成功结果）。
2. /tasks 管理器降级为列表组件（扩展无法聚焦组件/接管编辑器按键）；/attach 留核心。
3. todo 详情页不响应 Esc（/todo 循环关闭）。
4. uncertainty override 确认降级为 5 分钟自动拒绝的 confirm 对话框；增量审查弹窗移除
   （auto 模式默认开，行为不变）。
5. todo 压缩前刷新失去 maxTokens 上限（扩展无法覆盖 streamFn）。
6. getContextUsage 估算不再反映 prune（显示上限值；自动压缩触发用 provider 上报值，不受影响）。
7. read 结果无 [modified ...] 元数据行（陈旧检测由否决前置）。
