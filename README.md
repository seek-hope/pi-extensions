# Pi Agent — Extension Suite

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Pi](https://img.shields.io/badge/pi-%3E%3D0.80.0-blue)](https://pi.dev)

Production extension suite for [@earendil-works/pi-coding-agent](https://github.com/badlogic/pi-mono). Every extension wraps an **official upstream tool** — no third-party wrappers.

> **Note:** The following capabilities have graduated from this suite into the
> [pi-ex](https://github.com/seek-hope/pi-ex) core (built-in, no extension install
> needed): **subagent** (in-process multi-agent with git worktrees), **ssh**,
> **computer-use**, **todo flow**, **bg-tasks**, and **/btw**. The files were
> removed here; use pi-ex to get them. This repo now holds the remaining
> external-service and code-intelligence extensions.

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

## Extensions (12 files)

### Core Intelligence

| Extension | Official Tool | What It Does |
|-----------|--------------|--------------|
| `lsp.ts` | pyright / clangd / rust-analyzer / tsc | Diagnostics, hover, go-to-definition, find references for C/C++/Python/Rust/TypeScript |
| `serena.ts` | serena-agent (MCP) | Semantic symbol search, rename refactoring, project onboarding, diagnostics |
| `codegraph.ts` | @colbymchenry/codegraph | Call graphs, impact analysis, symbol search, structure exploration |
| `graphify.ts` | @sentropic/graphify | Knowledge graph: explain nodes, find shortest paths |

### External Services

| Extension | Official Tool | Auth |
|-----------|--------------|------|
| `github.ts` | `gh` CLI (GitHub official) | `gh auth login` |
| `anysearch.ts` | AnySearch REST API | `ANYSEARCH_API_KEY` |
| `huggingface.ts` | router.huggingface.co/v1 (OpenAI-compat) | `HF_TOKEN` |
| `agent-browser.ts` | agent-browser CLI (Vercel Labs) | none |
| `paddleocr.ts` | PaddleOCR Cloud API (PaddleOCR-VL-1.6) | token embedded |

### Documentation & Project Management

| Extension | What It Does |
|-----------|--------------|
| `docrelay.ts` | Code-documentation sync: impact analysis, CASCADE updates, stale doc detection |
| `project-setup.ts` | Auto-enables git/codegraph/docrelay/serena on every session start |
| `auto-update.ts` | `/update-tools` command: git pull + upgrade all npm/system tools |

### Graduated to pi-ex core

| Former extension | Now built into pi-ex as |
|------------------|-------------------------|
| `subagent.ts` | `subagent_*` tools (in-process AgentHarness + git worktrees) |
| `ssh.ts` | `ssh_exec`/`ssh_status`/`scp_*` tools + `/ssh` command |
| `computer-use.ts` | `computer_*` tools (Wayland-gated) |
| `todo.ts` | `todo_write` tool + todo widget + `/todo` command |
| `bg-tasks.ts` | `bg_spawn`/`bg_status` tools + `/tasks` `/fg` `/kill` `/attach` |
| `btw.ts` | `/btw` built-in command (in-process, no subprocess) |

## Architecture

```
pi session
  │
  ├─ Session Start
  │   ├─ project-setup.ts → auto-enable git/codegraph/docrelay/serena
  │   ├─ auto-update.ts   → git fetch, check for extension updates
  │   └─ AGENTS.md        → "search before answer" rules
  │
  ├─ AI Tools
  │   ├─ Code Intelligence:   codegraph_*, serena_*, lsp_*
  │   ├─ Browser:             agent_browser_snapshot/eval/click/fill
  │   ├─ OCR:                 paddle_ocr
  │   ├─ GitHub:              github_issue/pr/search/read_file
  │   ├─ HuggingFace:         huggingface_inference/chat/translate
  │   ├─ DocSync:             docrelay_status/check/impact/sync/link/diff
  │   └─ Knowledge:           graphify_explain/path
  │
  └─ User Commands
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
| agent-browser | `npm install -g agent-browser && agent-browser install` |
| grim / ydotool / wtype | `sudo pacman -S grim ydotool wtype` (Linux/Wayland, for pi-ex computer use) |

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
export ANYSEARCH_API_KEY="as_sk-..."       # https://anysearch.com
export HF_TOKEN="hf_..."                   # https://huggingface.co/settings/tokens
export ANTHROPIC_AUTH_TOKEN="sk-..."       # DeepSeek API key
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
export YDOTOOL_SOCKET=/tmp/.ydotool_socket # computer use
```

### Global Context (`~/.pi/agent/AGENTS.md`)

Loads automatically every session. Contains:
- Tool reference and workflow guidelines

## Project Layout

```
~/.pi/agent/extensions/
  ├── lsp.ts                 C/C++/Python/Rust/TS language servers
  ├── serena.ts              Semantic code tools (MCP)
  ├── codegraph.ts           Call graphs & impact analysis
  ├── graphify.ts            Knowledge graph
  ├── github.ts              GitHub issues/PRs/search
  ├── anysearch.ts           Web search
  ├── huggingface.ts         Model inference via router API
  ├── agent-browser.ts   Browser automation (agent-browser CLI)
  ├── paddleocr.ts           OCR via cloud API
  ├── docrelay.ts            Code-documentation sync
  ├── project-setup.ts       Auto-enable project infra
  ├── auto-update.ts         /update-tools command
  └── scripts/
      └── bootstrap.sh       One-command deployment
```

## Philosophy

- **Official tools only.** Every extension wraps the upstream tool directly.
- **No MCP framework.** Serena is MCP-native; everything else uses CLI/SDK/API.
- **Agent decides.** Prompt guidelines suggest patterns but the AI makes the final call.
- **Batteries included.** Session start auto-enables project infra; sub-agents auto-create git repos.
- **Search before answer.** AGENTS.md enforces Context7 → AnySearch fallback for technical questions.
