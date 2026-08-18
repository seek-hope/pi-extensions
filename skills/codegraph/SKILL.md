---
name: codegraph
description: "Pre-indexed code knowledge graph that auto-syncs on code changes, 100% local. Use for questions about code structure, symbols, call relationships, and blast radius in this project."
---

# CodeGraph

CodeGraph is a pre-indexed code knowledge graph for this project. It parses the codebase into a symbol graph (functions, classes, calls, imports) and keeps it current: a background daemon watches the project and updates the index on every file change, so the graph is never stale and there is nothing to re-run.

It answers questions like "how does X work", "what calls Y", "what breaks if I change Z" with far fewer tokens and tool calls than reading files or grepping, and it follows dynamic-dispatch hops (callbacks, interface implementations) that text search cannot.

## Usage

Run the CLI via the bash tool:

```
codegraph --help
```

`codegraph --help` is the authoritative, always-current command reference for the installed version. Discover subcommands and flags there rather than relying on memorized usage.

If a command reports that no index exists, follow the initialization guidance shown by `codegraph --help` (one-time per project; it builds the graph and enables auto-sync).
