# DeepSeek Harness (DSH) 移植分析

配套文档：[FEATURES.md](FEATURES.md) 是 pi-ex + pi-extensions 的**功能全集规格**（要复现什么）；
本文档回答：DSH（0.1.0-rc.8）的插件能力**能不能**承载这些功能，逐插件怎么映射，差距在哪。

DSH 版本：0.1.0-rc.8（本地检出 `/home/rimuru/Projects/Code/for_fun/deepseek-harness` @ 141eb6fef8）。
DSH 架构一句话：一切都是 Cordis 插件；扩展 = 监听类型化事件（waterfall/emit）+ 向 `ctx.*`
服务/seam 注册实现；agent 循环本身（`packages/core/agent-loop`）也是一个可替换的 bundle 插件。

---

## 1. 能力清单：18 项判定

| # | 能力 | 判定 | DSH 机制（出处） |
|---|------|------|------------------|
| 1 | 替换/自定义压缩 | **YES（整体替换）** | `ctx.compaction` seam：子类化 `CompactionEngine`（`compactIfNeeded/compactNow/compactRegion`），加载即替换内建 `compaction-basic`；自定义切点用 `compactRegion(start,end)` + `toolPairingBalancedBefore/After`；摘要可覆写 `summarize()` 或直接 `ctx.llm.stream()`（packages/compaction/compaction/README.md） |
| 2 | 每次 LLM 调用前变换出站消息 | **PARTIAL / 基本 NO** | `llm/stream` 处请求已深冻结，"listeners read it, never rewrite it"（docs/subsystems/llm-streaming.md）。绕行：(a) `agent/pre-step` 串行监听器可改写/拒绝**入站认领消息**（docs/architecture.md）；(b) 短接 `llm/stream` 自己产 chunk（专家级，破坏可重建性）；(c) `ctx.toolResultPruner` seam 做**持久化**剪除（写回会话，非按调用） |
| 3 | 注册模型可见工具 | **YES** | `ctx.tools.register()` / `defineTool()`；schema DSL 或裸 JSON Schema；必须带 `output{schema,render}`；全局或 agent 作用域（packages/core/tools/README.md） |
| 4 | tool_call 拦截（阻断/改参数） | **PARTIAL** | `tools/pre-execute` waterfall 返回 `{kind:'deny',reason}`（reason 以错误结果给模型）或 `{kind:'ask'}`；**不能改参数**（"Input rewriting is excluded because arguments are already logged and presented"，packages/core/tools/src/index.ts:582-592） |
| 5 | tool_result 后处理 | **YES** | `tools/post-execute` 返回 `PostToolDecision`：替换 content/value、附 `additionalContexts`、或 block 转错误（packages/core/tools/src/index.ts:594-600） |
| 6 | 系统提示词逐轮追加 | **YES** | `ctx.systemPrompt.section()`（有序、作用域遮蔽、可链式贡献）+ `system-prompt/assemble` 整体装配 waterfall |
| 7 | 观察定稿消息/会话事件 | **YES** | `ctx.on('session/event', …)` 事件流：`assistant/chunk`、`assistant/message`、`user/message`、turn/step 边界（packages/core/session/src/index.ts:76） |
| 8 | 注入 steer/follow-up 唤醒 | **YES** | `Agent.followup()`（排队新回合、唤醒空闲 agent）、`Agent.steer()`（下一步注入）；`agent/turn-stopping` 可强制续步 |
| 9 | UI：组件/对话框/斜杠命令 | **YES/PARTIAL** | UI slots + keyed chat renderers（packages/client/ui-slots）；对话框 `ctx.approval`（confirm）+ `ctx.userQuestions`（选项/多选/自由文本，**无密码掩码输入**）；命令 `ctx.commands.register()` |
| 10 | 会话状态读写（自定义条目持久化） | **YES** | `session.events` 只读快照 + `session.append(type, data)` 追加自定义事件（声明合并进 `SessionEventMap`），`ctx.sessions.flush()` 落盘（compaction 的 `compaction/*` 事件就是官方示例） |
| 11 | 插件发起 LLM 调用（会话模型+鉴权） | **YES** | `ctx.llm.stream(options)` / `prepareCall(config)`；鉴权经 `ctx.credentials` 内部解析；辅助调用有 `GenerateOptions.purpose`（'compaction'/'session-title'）；自定义流函数 = 注册自己的 `LlmAdapter`（packages/llm/llm） |
| 12 | 插件设置系统 | **YES** | 两层：组合配置 `cordis.yml`（Schemastery `Config` schema 校验）+ 用户可改的命名空间设置 `ctx.settings.register(namespace, schema)`（分层解析、热提交、外部修改观察、文件存储，packages/settings） |
| 13 | 子代理（worktree 隔离/DAG/review-merge/只读） | **PARTIAL/NO（原生语义缺）** | 无 git worktree 隔离、无 DAG 依赖、无 review/merge 流、无 readOnly 标志；最接近的是 `toolFilter: ToolRestriction` + `maxDepth`/`persona`（packages/subagent/subagent/src/types.ts）。**插件可驱动**：`ctx.subagents.start()`；内建后端 spawn/fork-in-process、ACP、Codex、Claude Code、dsh-sdk |
| 14 | 后台任务（tmux 式 + 完成通知） | **YES** | `ctx.jobs.start(JobStart{kind,label,run})`，状态机 + 完成通知 + cancel/wait/output-read（经 tool-jobs 暴露给模型）；`JobKindMap` 声明合并可扩展插件任务类型；进程内实现（jobs-local，非 tmux） |
| 15 | 远程执行（SSH） | **NO** | 无任何 SSH；"remote" 指可替换执行环境 provider（e2b）与 Host↔Client RPC，不是 SSH 到服务器 |
| 16 | 桌面自动化（computer use） | **NO** | 无截图/键鼠；工具目录只有 bash/pwsh、fs、terminal(PTY)、web、LSP、subagents（docs/tool-catalog.md） |
| 17 | 循环控制（最大轮数/并行批超时） | **PARTIAL** | 最大轮数：**无内建**，官方说法是"要限制失控轮数就从 `agent/turn-stopping` 等生命周期扩展点取消"（packages/core/agent-loop/README.md:134）。批级超时：无；只有逐工具 `timeoutMs`（`timeout-policy` 插件，协作式非硬杀）。并发上限 `maxParallelToolCalls`（默认 10）可配 |
| 18 | 插件加载/发现 | **YES** | Cordis YAML 配置树：`cordis.yml` 条目 `{id,name,config?,disabled?,inject?}`；specifier 支持**相对路径**（配置目录锚定）或裸 npm 名；生命周期 = Loader import → inject 门控 → dispose/rollback，带 HMR；`disabled: true` 禁用；`$DSH_HOME/profiles/` 下 `cordis.patch.yml` 分层 |

附注：

- **E1 API 稳定性**：无保证。README："developer preview … THERE WILL BE COMPATIBILITY-BREAKING CHANGES." 插件 API 无 deprecation/semver 政策。
- **E2 "插件不能做 X"清单**：无统一清单。最接近的明示限制：插件代码在安装时于**沙箱外**执行（publish.md）；tool 参数不可改写（item 4）；`llm/stream` 请求不可改写（item 2）。
- **E3 独立仓库分发**：可以。`cordis.yml` specifier 支持相对路径（开发期直接指到仓库目录）；分发走 npm 或 `pnpm pack` tarball，`dsh plugin add <pkg|tgz>` 安装。

---

## 2. 逐插件移植映射

对照 FEATURES.md 的 9 个插件 + 宿主桥：

### 2.1 context（压缩管线 + prune + recall + uncertainty + 文件状态）

| 子功能 | DSH 挂载点 | 可行性 |
|--------|-----------|--------|
| 压缩管线（轮切点/全保真序列化/结构化检查点） | `ctx.compaction` seam 整体替换 `compaction-basic`；摘要调用走 `ctx.llm.stream()`（purpose='compaction'）；检查点持久化用 `compaction/summary` 事件 + `session.append` | **YES**——这是 DSH 做得最好的部分，seam 就是为此设计的 |
| prune | **两条路**：(a) `ctx.toolResultPruner` seam——持久化剪除（写回会话事件），与 recall 天然配套（原文仍在历史里时被剪除指向检索）；(b) `agent/pre-step` 按调用前改写入站消息（非官方语义，风险自担） | **PARTIAL**——按调用的"软剪除"（上下文里剪、存档里全）做不到；持久剪除（存档即剪）可以做到，语义变化见 §3.1 |
| recall | 工具注册（YES）+ 会话事件树读（YES）+ 自定义条目（YES） | **YES** |
| uncertainty（扫描/复审/确认） | `session/event` 观察定稿消息（7）、`tools/post-execute` 按 path 失效（5）、`ctx.approval` 确认（9）、followup 注入（8） | **YES** |
| 文件状态追踪 + 陈旧否决 | `tools/post-execute` 喂养追踪（5）；`tools/pre-execute` deny 阻断陈旧写（4——只需 deny 不需改参数，够用） | **YES** |
| 系统提示词注入（work-loop 引导） | `ctx.systemPrompt.section()`（6） | **YES** |

### 2.2 bash-gate

`tools/pre-execute` deny + reason（item 4 的机制完全覆盖：只需阻断+给模型看理由，不需要改参数）。**YES**。

### 2.3 ask-wait

- ask_user：工具注册 + `ctx.userQuestions`（选项/自由文本）。**YES**（headless 回退逻辑照旧）。
- wait：工具注册 + 定时器到点 `Agent.followup()` 唤醒。**YES**。

### 2.4 todo

工具注册 + 自定义会话条目持久化（`session.append`）+ UI slots 渲染组件 + `session/event` 数用户输入（过期提醒）+ 压缩前刷新（在自定义 CompactionEngine 里内联触发，比 pi 的"取消-刷新-重触发"更直接）。**YES**。

### 2.5 bg-tasks

`ctx.jobs` 提供任务协议、状态机、完成通知、模型侧工具暴露——**但实现是进程内的，不是 tmux**。两条路：(a) 直接用 `ctx.jobs`（放弃 tmux 的进程级存活/attach 能力）；(b) 保留现有 tmux store（~960 行自包含），把 `ctx.jobs.start` 当通知/暴露层包装在外面。**YES**（(b) 保真度最高）。

### 2.6 ssh

DSH 无原生 SSH——但 pi 也没有；现有实现本来就是纯插件自实现（持久 ControlMaster 管理 + 工具注册 + masked input）。工具注册 YES；**masked 密码输入缺失**（`ctx.userQuestions` 只有选项/自由文本）→ sudo 流程退化：明文对话框（不可接受）或要求用户先 `/ssh sudo` 式手动 prime（走终端 prompt 而非插件对话框）。**PARTIAL**。

### 2.7 computer-use

DSH 无原生桌面自动化——同 ssh，现有实现是 grim/ydotool/wtype 外部二进制封装，工具注册即可平移。**YES**。

### 2.8 subagent

差距最大的一块。DSH 原生子代理无 worktree 隔离、无 DAG、无 review/merge、无只读路径。但：
- 现有 `subagent/lib/core/`（~1700 行管理器 + worktree 封装）**自包含、无 pi 依赖**——整个搬到 DSH 插件里，worktree/DAG/review-merge 语义全部保留；
- 子代理循环用 `ctx.subagents.start()`（spawn 后端）驱动，或继续自带循环 + `ctx.llm.stream()`；
- 只读路径的"机械不可写"用 `toolFilter: ToolRestriction` + 自带写门实现。
**YES（成本中等）**——核心是移植，不是重写。

### 2.9 codegraph-scan

`tools/post-execute` 后追加内容（`additionalContexts` 或直接改 content）。**YES**。

### 2.10 fork-host bridge

**不需要**。bridge 暴露的三样东西 DSH 原生都有：`streamFn` → `ctx.llm.stream()` / 自定义 `LlmAdapter`；`settingsManager` → `ctx.settings.register`；`modelRuntime` → `ctx.llm` + `ctx.credentials`。这是迁移到 DSH 的净收益之一：60 行 fork 核心代码归零。

---

## 3. 关键差距与应对

### 3.1 prune 的语义变化（最重要的一条）

pi 里 prune 是**按调用的出站变换**：存档永远全量，只有发给模型的消息被剪。DSH 的
`llm/stream` 请求深冻结，这条路不存在。可行替代是 `ctx.toolResultPruner` seam 的
**持久剪除**：剪除写回会话事件本身。

语义差异：
- 视觉：会话回放里被剪输出也显示 stub（pi 里回放保持全量）——可接受，stub 本来就带 recall 指引；
- recall：剪除后原文是否仍可检索，取决于 DSH 的 toolResultPruner 是否保留原文副本。
  **未验证**——若 pruner 是破坏性覆写，需要在剪除前把原文 `session.append` 到自定义
  存档条目（recall 插件读自己的存档），反而比 pi 的实现更干净（存档与上下文彻底分离）。

### 3.2 需要 DSH 核心补丁/上游请求的点

| 缺口 | 影响 | 应对 |
|------|------|------|
| masked 密码输入 | ssh sudo 流程 | 退化方案：sudo 密码只经终端内 `read -s` 式手动 prime，不走插件对话框；或给 DSH 提 `userQuestions` masked intent |
| 最大轮数无内建 | MAX_LOOP_TURNS=50 防死循环 | 插件用 `agent/turn-stopping` 计数取消（官方推荐路径，够用） |
| 批级并行工具超时 | 20min 批超时 | `timeout-policy` 逐工具 `timeoutMs` 近似（协作式）；批级语义需 patch agent-loop |
| tool 参数不可改写 | 无影响 | bash-gate/file-state 都只需 deny |
| API 无稳定性保证（developer preview） | 升级维护成本 | 锁版本 + 把对 DSH API 的依赖收敛到一个 adapter 文件 per 插件 |

### 3.3 迁移后**变简单**的部分

- fork-host bridge 删除（DSH 原生提供等价物）；
- 压缩前 todo 刷新的"取消-刷新-重触发"杂技消失（自定义 CompactionEngine 内部直接跑刷新步）；
- 设置不再需要 fork schema 注册（`ctx.settings.register` 是正式 API）；
- prune 若走持久剪除，§FEATURES 12.6 的 contextUsage 估算折损消失。

### 3.4 迁移后**仍需验证**的点

- `ctx.toolResultPruner` 是否保留原文（决定 recall 存档设计）；
- 自定义 CompactionEngine 的触发时机/预算语义与 pi 的 thresholdRatio 模型如何对应；
- `ctx.jobs` 进程内实现对 pi 会话重启的恢复语义（tmux 方案无此问题）；
- TUI 侧 UI slots 的表达能力是否够 todo/bg-tasks 组件的交互（pi 折损清单 §FEATURES 12.2/12.3 在 DSH 是否同样存在）；
- DSH 是 developer preview，RC 期间 breaking change 的实际频率。

---

## 4. 结论

**DSH 的插件能力可以承载这套自定义需求**，且比 pi 的扩展 API 更系统：压缩、工具、会话事件、
设置、LLM 调用、子代理驱动、后台任务、UI 全是正式 seam（18 项中 13 项 YES、4 项 PARTIAL、
仅 SSH/computer-use 两项 NO——而这两项在 pi 里同样是全自实现，不构成迁移障碍）。

真正需要设计决策的只有一处：**prune 从按调用软剪除变为持久剪除**（§3.1）。其余的 PARTIAL
项都有够用的绕行路径。主要风险不是能力缺失，而是 DSH 处于 developer preview、API 无稳定性
承诺（E1）——建议把每个插件对 DSH API 的调用收敛到单文件 adapter，锁死 DSH 版本升级。

建议迁移顺序（依赖递增）：codegraph-scan → bash-gate → ask-wait → todo → bg-tasks →
computer-use → ssh → context（最大）→ subagent（移植 core）。
