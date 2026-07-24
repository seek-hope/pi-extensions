# Pi Agent — Extension Suite

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Pi](https://img.shields.io/badge/pi-%3E%3D0.80.0-blue)](https://pi.dev)

Production extension suite for [@earendil-works/pi-coding-agent](https://github.com/badlogic/pi-mono). Every extension wraps an **official upstream tool** — no third-party wrappers. Git-worktree sub-agents, persistent SSH, computer use, LSP, and more.

## Quick Deploy

```bash
curl -fsSL https://raw.githubusercontent.com/seek-hope/pi-extensions/master/scripts/bootstrap.sh | bash
```

Or manually:

```bash
git clone https://github.com/seek-hope/pi-extensions ~/.pi/agent/extensions
pi
/reload
```

## Extensions (18 files, 77 tools, 6 commands)

### Core Intelligence

| Extension | Official Tool | What It Does |
|-----------|--------------|--------------|
| `lsp.ts` | pyright / clangd / rust-analyzer / tsc | Diagnostics, hover, go-to-definition, find references for C/C++/Python/Rust/TypeScript |
| `serena.ts` | serena-agent (MCP) | Semantic symbol search, rename refactoring, project onboarding, diagnostics |
| `codegraph.ts` | @colbymchenry/codegraph | Call graphs, impact analysis, symbol search, structure exploration |
| `graphify.ts` | @sentropic/graphify | Knowledge graph: explain nodes, find shortest paths |

### Multi-Agent System

`subagent.ts` — 9 tools. Git-worktree isolation, recursive up to depth 5.

| Tool | Purpose |
|------|---------|
| `subagent_spawn` | Spawn isolated sub-agent in git worktree (analyze/improve/execute modes) |
| `subagent_wait` | Collect result when done |
| `subagent_review` | Inspect git diff before merging |
| `subagent_merge` / `subagent_reject` | Accept or discard changes |
| `subagent_parallel` | Fan-out N agents simultaneously |
| `subagent_list` | List running sub-agents and worktrees |
| `subagent_cancel` | Cancel a running sub-agent and clean up |
| `subagent_ensure_git` | Initialize git repo if one doesn't exist |

### SSH & Remote

`ssh.ts` — 5 tools. Persistent multiplexed connections, standard SSH syntax.

| Tool | Purpose |
|------|---------|
| `ssh_exec` | Execute commands via persistent ControlMaster connection |
| `ssh_status` | Check active connections |
| `scp_to_remote` / `scp_from_remote` | File transfer via existing connection |
| `ssh_exec(background=true)` | Long tasks auto-wrapped in `nohup` on remote |

### Computer Use

`computer-use.ts` — 11 tools. Desktop automation for Hyprland/Wayland.

| Tool | Purpose |
|------|---------|
| `computer_screenshot` | Full-screen or region screenshot (base64 PNG) |
| `computer_move` / `computer_click` / `computer_double_click` | Mouse control |
| `computer_type` / `computer_key` | Keyboard input |
| `computer_scroll` / `computer_drag` | Scroll and drag |
| `computer_get_position` / `computer_get_screen_size` | Display info |

### External Services

| Extension | Official Tool | Auth |
|-----------|--------------|------|
| `github.ts` | `gh` CLI (GitHub official) | `gh auth login` |
| `context7.ts` | Context7 REST API | `CONTEXT7_API_KEY` |
| `anysearch.ts` | AnySearch REST API | `ANYSEARCH_API_KEY` |
| `huggingface.ts` | router.huggingface.co/v1 (OpenAI-compat) | `HF_TOKEN` |
| `playwright.ts` | Playwright (Microsoft) | none |
| `paddleocr.ts` | PaddleOCR Cloud API (PaddleOCR-VL-1.6) | token embedded |

### Documentation & Project Management

| Extension | What It Does |
|-----------|--------------|
| `docrelay.ts` | Code-documentation sync: impact analysis, CASCADE updates, stale doc detection |
| `project-setup.ts` | Auto-enables git/codegraph/docrelay/serena on every session start |
| `auto-update.ts` | `/update-tools` command: git pull + upgrade all npm/system tools |

### Session Utilities

| Extension | What It Does |
|-----------|--------------|
| `bg-tasks.ts` | `/bg` — tmux-based background tasks, survive session end, disk-persisted |
| `btw.ts` | `/btw <question>` — ask temporary questions without polluting session |

## Architecture

```
pi session
  │
  ├─ Session Start
  │   ├─ project-setup.ts → auto-enable git/codegraph/docrelay/serena
  │   ├─ auto-update.ts   → git fetch, check for extension updates
  │   └─ AGENTS.md        → "search before answer" rules
  │
  ├─ AI Tools (77 across all extensions)
  │   ├─ Code Intelligence:   codegraph_*, serena_*, lsp_*
  │   ├─ Sub-agents:          subagent_spawn/parallel/review/merge/reject/list/cancel/ensure_git
  │   ├─ SSH & SCP:           ssh_exec, ssh_status, scp_to_remote, scp_from_remote
  │   ├─ Computer Use:        computer_screenshot/move/click/type/key/scroll/drag
  │   ├─ Search:              context7_search, anysearch_web
  │   ├─ Browser:             playwright_snapshot/eval/click/fill
  │   ├─ OCR:                 paddle_ocr
  │   ├─ GitHub:              github_issue/pr/search/read_file
  │   ├─ HuggingFace:         huggingface_inference/chat/translate
  │   ├─ DocSync:             docrelay_status/check/impact/sync/link/diff
  │   └─ Knowledge:           graphify_explain/path
  │
  └─ User Commands
      ├─ /btw              → temporary side question
      ├─ /bg               → background tasks (tmux-managed)
      ├─ /tasks            → list background tasks
      ├─ /ssh              → persistent SSH connections
      ├─ /subagent         → manual sub-agent management
      └─ /update-tools     → upgrade everything
```

## Prerequisites

| Tool | Install |
|------|---------|
| Node.js ≥ 20 | [nodejs.org](https://nodejs.org) |
| pi | `npm install -g @earendil-works/pi-coding-agent` |
| gh CLI | `sudo apt install gh && gh auth login` |
| clangd | `sudo apt install clangd` |
| rust-analyzer | `rustup component add rust-analyzer` |
| serena | `uv tool install serena-agent` |
| Playwright browsers | `npx playwright install chromium` |
| grim / ydotool / wtype | `sudo pacman -S grim ydotool wtype` (Linux/Wayland) |

Global npm tools are auto-installed by `bootstrap.sh`. API keys go in `~/.zshrc`.

## Configuration

### pi settings (`~/.pi/agent/settings.json`)

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-pro",
  "defaultThinkingLevel": "max",
  "defaultProjectTrust": "always"
}
```

### API Keys (`~/.zshrc`)

```bash
export CONTEXT7_API_KEY="ctx7sk-..."       # https://context7.com
export ANYSEARCH_API_KEY="as_sk-..."       # https://anysearch.com
export HF_TOKEN="hf_..."                   # https://huggingface.co/settings/tokens
export ANTHROPIC_AUTH_TOKEN="sk-..."       # DeepSeek API key
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
export YDOTOOL_SOCKET=/tmp/.ydotool_socket # computer use
```

### Global Context (`~/.pi/agent/AGENTS.md`)

Loads automatically every session. Contains:
- "Search before answer" rules (context7 → anysearch fallback)
- Tool reference and workflow guidelines

## Project Layout

```
~/.pi/agent/extensions/
  ├── lsp.ts                 C/C++/Python/Rust/TS language servers
  ├── serena.ts              Semantic code tools (MCP)
  ├── codegraph.ts           Call graphs & impact analysis
  ├── graphify.ts            Knowledge graph
  ├── subagent.ts            Git-worktree multi-agent system (9 tools)
  ├── ssh.ts                 Persistent SSH + SCP (5 tools)
  ├── computer-use.ts        Desktop automation for Wayland (11 tools)
  ├── github.ts              GitHub issues/PRs/search
  ├── context7.ts            Documentation search
  ├── anysearch.ts           Web search
  ├── huggingface.ts         Model inference via router API
  ├── playwright.ts          Browser automation
  ├── paddleocr.ts           OCR via cloud API
  ├── docrelay.ts            Code-documentation sync
  ├── project-setup.ts       Auto-enable project infra
  ├── auto-update.ts         /update-tools command
  ├── bg-tasks.ts            /bg background tasks (tmux)
  ├── btw.ts                 /btw side-query command
  └── scripts/
      └── bootstrap.sh       One-command deployment
```

## Philosophy

- **Official tools only.** Every extension wraps the upstream tool directly.
- **No MCP framework.** Serena is MCP-native; everything else uses CLI/SDK/API.
- **Agent decides.** Prompt guidelines suggest patterns but the AI makes the final call.
- **Batteries included.** Session start auto-enables project infra; sub-agents auto-create git repos.
- **Search before answer.** AGENTS.md enforces Context7 → AnySearch fallback for technical questions.
