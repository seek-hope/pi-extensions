# Pi Agent — Extension Suite

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Pi](https://img.shields.io/badge/pi-%3E%3D0.80.0-blue)](https://pi.dev)

Production extension suite for [@earendil-works/pi-coding-agent](https://github.com/badlogic/pi-mono). Every extension wraps an **official upstream tool** — no third-party wrappers.

> **Note:** `serena` is no longer bundled in this suite. If you use it, install and enable it independently (`uv tool install serena-agent`).

## Knowledge-graph CLIs: skills, not wrappers

`graphify` and `codegraph` are **not** wrapped as native tools. The model invokes their CLIs directly via the bash tool and learns them from skills, so their integration surface is vendor-maintained:

- **graphify** — official pi skill, installed by `graphify install --platform pi` (writes `~/.pi/agent/skills/graphify/`). Covers the full lifecycle (build / update / query / wiki / exports).
- **codegraph** — pi skill at `skills/codegraph/` in this repo (symlinked to `~/.pi/agent/skills/codegraph`). CodeGraph's only official agent integration is MCP, which pi does not support, so the skill defers all usage to `codegraph --help` and stays near-zero maintenance. Its daemon auto-syncs the index on file changes; consumers are read-only.

The previous `codegraph.ts` / `graphify.ts` wrapper extensions were removed — they duplicated the CLI surface and drifted out of sync with it.

## Extensions

### Core Intelligence

| Extension | Provides | Prerequisites |
|-----------|----------|---------------|
| `docrelay.ts` | Code-doc sync tracking: `docrelay_init`, `docrelay_status`, `docrelay_health`, `docrelay_review`, `docrelay_check`, `docrelay_impact`, `docrelay_sync`, `docrelay_link`, `docrelay_diff` | `uv tool install docrelay` |
| `lsp.ts` | Real compiler diagnostics & navigation: `lsp_diagnostics`, `lsp_project_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references` (pyright, tsgo, rust-analyzer, clangd) | `npm i -g pyright typescript-language-server typescript` |

### Automation & Productivity

| Extension | Provides | Prerequisites |
|-----------|----------|---------------|
| `github.ts` | GitHub issue/PR tools via `gh` CLI (`github_issue`, `github_pr`, `github_search`) + reads files from repos | `gh` CLI, authenticated |
| `anysearch.ts` | Web search (finance/stocks/structured data focus) | None (optional `ANYSEARCH_API_KEY` for higher limits) |
| `agent-browser.ts` | Browser automation: snapshot, eval, click, fill | `npx agent-browser` |
| `import-repro.ts` | `/ir` — import a pi session shared as a gist by the issue-analysis CI workflow and switch to it | `gh` CLI |
| `prompt-url-widget.ts` | Border widget that surfaces GitHub PR / issue / security-advisory URLs detected in the prompt | None |
| `redraws.ts` | `/tui` — show TUI redraw statistics | None |
| `tps.ts` | Post-run notification with tokens/sec and token usage (output/input/cache/total) | None |

### Developer Utilities & Providers

| Extension | Provides | Prerequisites |
|-----------|----------|---------------|
| `huggingface.ts` | HF model inference/chat/translation (`huggingface_inference`, `huggingface_chat`, `huggingface_translate`) | `HF_TOKEN` |
| `paddleocr.ts` | OCR for images (`paddle_ocr`) | Local PaddleOCR v5 + ONNX Runtime |
| `tokenrouter.ts` | Registers the TokenRouter provider (OpenAI-compatible gateway) with its model catalog | `TOKENROUTER_API_KEY` |
| `project-setup.ts` | `project_setup` — auto-enable git, CodeGraph, DocRelay in the current project | Those tools installed |
| `auto-update.ts` | Keeps the suite fresh (ff-only pull on session start) | `git` |

## Architecture

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────────┐
│  project_setup (auto-enable: git, codegraph,│
│  docrelay)                                  │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Semantic Layer     │  codegraph CLI via bash (skill-guided; daemon
│                     │  keeps the index fresh — consumers are read-only)
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Sync Layer         │  docrelay_* tools (code ↔ docs)
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Compiler Layer     │  lsp_* tools (ground truth diagnostics)
└─────────────────────┘
    │
    ▼
Verified Code + Updated Docs
```

## Design Philosophy

- **No MCP framework.** External CLIs are wrapped as native extensions instead. MCP adds config files, process management, and tool-prefix indirection; a TypeScript file is simpler and faster.
- **Official upstream tools only.** Every extension delegates to the vendor's own CLI/API (`gh`, `pyright`, `agent-browser`, codegraph, docrelay).
- **Skills over wrappers for big CLIs.** Tools with a broad, fast-moving command surface (graphify, codegraph) are used through vendor-maintained or `--help`-deferring skills — wrapping them drifts. Tools with a small stable surface stay native extensions.
- **Prerequisites are explicit.** Each extension documents exactly what it needs; missing prerequisites degrade gracefully (tool hidden or clear error).

## Installation

The suite lives in the user-level extension directory so it is available in every project:

```bash
git clone https://github.com/seek-hope/pi-extensions ~/pi-extensions
ln -s ~/pi-extensions ~/.pi/agent/extensions
```

`auto-update.ts` keeps it current: on session start it fast-forward pulls the repo (ff-only; local changes are never touched).

## Prerequisites

| Tool | Install | Needed for |
|------|---------|------------|
| `gh` | `brew install gh` / `apt install gh` | github, import-repro |
| `pyright` | `npm i -g pyright` | lsp (Python) |
| `typescript-language-server` | `npm i -g typescript-language-server typescript` | lsp (TypeScript) |
| `codegraph` | `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh \| sh` (or `npm i -g @colbymchenry/codegraph`) | semantic layer (bash + skill) |
| `graphify` | `uv tool install graphifyy`, then `graphify install --platform pi` | knowledge-graph Q&A (bash + skill) |
| `docrelay` | `uv tool install docrelay` | docrelay |
| `agent-browser` | `npx agent-browser` | agent-browser |
| `HF_TOKEN` | https://huggingface.co/settings/tokens | huggingface |
| `ANYSEARCH_API_KEY` | https://anysearch.ai | anysearch (optional) |
| `TOKENROUTER_API_KEY` | https://docs.tokenrouter.me/ | tokenrouter |

## Project Structure

```
pi-extensions/
├── docrelay.ts         # Code-doc sync tracking
├── lsp.ts              # Compiler diagnostics & navigation
├── github.ts           # GitHub operations
├── anysearch.ts        # Web search
├── agent-browser.ts    # Browser automation
├── import-repro.ts     # /ir gist session import
├── prompt-url-widget.ts# GitHub URL border widget
├── redraws.ts          # /tui redraw stats
├── tps.ts              # Post-run TPS/usage notification
├── huggingface.ts      # HF inference/chat/translation
├── paddleocr.ts        # OCR
├── tokenrouter.ts      # TokenRouter provider
├── project-setup.ts    # Auto-enable git/codegraph/docrelay
├── auto-update.ts      # Self-updating on session start
├── skills/
│   └── codegraph/      # Minimal pi skill (defers to codegraph --help)
├── scripts/            # Helper scripts
└── README.md
```

## License

MIT
