# Pi Agent — Extension Suite

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Pi](https://img.shields.io/badge/pi-%3E%3D0.80.0-blue)](https://pi.dev)

Production extension suite for [@earendil-works/pi-coding-agent](https://github.com/badlogic/pi-mono). Every extension wraps an **official upstream tool** — no third-party wrappers. Git-worktree sub-agents, LSP diagnostics, documentation sync, and more.

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

## Extensions (15)

### Core Intelligence

| Extension | Official Tool | What It Does |
|-----------|--------------|--------------|
| `lsp.ts` | pyright / clangd / rust-analyzer / typescript-ls | Diagnostics, hover, go-to-definition, find references for C/C++/Python/Rust/TypeScript |
| `serena.ts` | serena-agent (MCP) | Semantic symbol search, rename refactoring, project onboarding |
| `codegraph.ts` | @colbymchenry/codegraph | Call graphs, impact analysis, symbol search, structure exploration |
| `graphify.ts` | @sentropic/graphify | Knowledge graph: build, query, explain, blast-radius analysis |

### Multi-Agent System

| Extension | What It Does |
|-----------|--------------|
| `subagent.ts` | Git-worktree isolated sub-agents: spawn, parallel fan-out, sequential chain, auto review→fix→re-review loop, recursive up to depth 5 |

| Tool | Purpose |
|------|---------|
| `subagent_spawn` | Spawn isolated sub-agent in git worktree |
| `subagent_wait` | Collect result when done |
| `subagent_review` | Inspect git diff before merging |
| `subagent_refine` | Review → fix → re-review loop until clean |
| `subagent_merge` / `subagent_reject` | Accept or discard changes |
| `subagent_parallel` | Fan-out N agents simultaneously |
| `subagent_chain` | Sequential pipeline with context passing |

### External Services

| Extension | Official Tool | Auth |
|-----------|--------------|------|
| `github.ts` | `gh` CLI (GitHub official) | `gh auth login` |
| `context7.ts` | Context7 REST API | `CONTEXT7_API_KEY` |
| `anysearch.ts` | AnySearch REST API | `ANYSEARCH_API_KEY` |
| `huggingface.ts` | @huggingface/inference | `HF_API_KEY` |
| `playwright.ts` | Playwright (Microsoft) | none |
| `paddleocr.ts` | PaddleOCR v5 + ONNX | none |

### Documentation & Project Management

| Extension | What It Does |
|-----------|--------------|
| `docrelay.ts` | Code-documentation sync: impact analysis, CASCADE updates, stale doc detection |
| `project-setup.ts` | Auto-enables git/codegraph/docrelay/serena on every session start |
| `auto-update.ts` | `/update-tools` command: git pull + upgrade all npm/system tools |
| `btw.ts` | `/btw <question>`: ask temporary questions without polluting session |

## Architecture

```
pi session
  │
  ├─ Session Start
  │   ├─ project-setup.ts → git init? codegraph init? docrelay init? serena init?
  │   └─ auto-update.ts   → git fetch, check for extension updates
  │
  ├─ AI Tools (35+ registered across all extensions)
  │   ├─ Code Intelligence:   codegraph_*, serena_*, lsp_*
  │   ├─ Sub-agents:          subagent_spawn/parallel/chain/review/merge/reject/refine
  │   ├─ Search:              context7_search, anysearch_web
  │   ├─ Browser:             playwright_snapshot/eval/click/fill
  │   ├─ OCR:                 paddle_ocr
  │   ├─ GitHub:              github_issue/pr/search/read_file
  │   ├─ HuggingFace:         huggingface_inference/chat/translate
  │   ├─ DocSync:             docrelay_status/check/impact/sync/link/diff
  │   └─ Knowledge:           graphify_build/query/explain/impact
  │
  └─ User Commands
      ├─ /btw              → temporary side question
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
export ANYSEARCH_API_KEY="as_sk_..."       # https://anysearch.com
export HF_API_KEY="hf_..."                 # https://huggingface.co/settings/tokens
export ANTHROPIC_AUTH_TOKEN="sk-..."       # DeepSeek API key
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
```

### Sub-agent Model Selection

Sub-agents default to the main agent's model. Override per task:

```
subagent_spawn(task="simple search", model="deepseek-v4-flash")   # cheap tasks
subagent_spawn(task="complex refactor")                           # default (v4-pro)
```

## Update

```bash
# In pi:
/update-tools        # git pull + upgrade all npm & system tools

# Or manually:
cd ~/.pi/agent/extensions && git pull && pi /reload
```

## Project Layout

```
~/.pi/agent/extensions/
  ├── lsp.ts                 C/C++/Python/Rust/TS language servers
  ├── serena.ts              Semantic code tools (MCP)
  ├── codegraph.ts           Call graphs & impact analysis
  ├── graphify.ts            Knowledge graph
  ├── subagent.ts            Git-worktree multi-agent system
  ├── github.ts              GitHub issues/PRs/search
  ├── context7.ts            Documentation search
  ├── anysearch.ts           Web search
  ├── huggingface.ts         Model inference & translation
  ├── playwright.ts          Browser automation
  ├── paddleocr.ts           OCR text extraction
  ├── docrelay.ts            Code-documentation sync
  ├── project-setup.ts       Auto-enable project infra
  ├── auto-update.ts         /update-tools command
  ├── btw.ts                 /btw side-query command
  └── scripts/
      └── bootstrap.sh       One-command deployment
```

## Philosophy

- **Official tools only.** Every extension wraps the upstream tool directly (e.g. Microsoft's playwright, not a community pi-playwright wrapper).
- **No MCP framework.** Serena is MCP-native and integrated at that level; everything else uses CLI/SDK/API directly.
- **Agent decides.** Prompt guidelines suggest when to use sub-agents, which model to pick, and when to review before merging — but the AI makes the final call.
- **Batteries included.** Session start auto-enables git/codegraph/docrelay/serena. Sub-agents auto-create git repos. Tools auto-update.
