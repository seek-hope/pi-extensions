/**
 * DocRelay extension for pi — wraps the official doc-relay CLI.
 * Official upstream: https://github.com/seek-hope/docrel
 *
 * DocRelay treats documentation like a database: foreign keys between
 * code symbols and doc sections, CASCADE updates, and git hooks.
 * Uses Codegraph for symbol identity tracking across renames.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

const BIN = "doc-relay";

function run(args: string[], cwd: string): string {
  return execFileSync(BIN, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
}

export default function (pi: ExtensionAPI) {
  // ── init ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "docrelay_init",
    label: "DocRelay Init",
    description:
      "Initialize DocRelay in the current project: creates config, database, installs git hooks, and scans the codebase for symbols via Codegraph.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["init"], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── status ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "docrelay_status",
    label: "DocRelay Status",
    description:
      "Show DocRelay health dashboard: symbol count, documentation sync percentage, stale docs, and database integrity.",
    parameters: Type.Object({}),
    promptGuidelines: [
      "Use docrelay_status to check the project's documentation health before and after making code changes.",
    ],
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["status"], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── check ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "docrelay_check",
    label: "DocRelay Check",
    description:
      "List all stale documentation (docs whose linked code symbols have changed). Use --strict for CI (exits code 1 if stale docs exist).",
    parameters: Type.Object({
      strict: Type.Optional(Type.Boolean({ description: "Exit with code 1 if stale docs exist (default: false)" })),
    }),
    promptGuidelines: [
      "Use docrelay_check before committing to ensure no documentation is left stale.",
      "Use docrelay_check with strict=true in CI/CD pipelines to block merges with stale docs.",
    ],
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const args = ["check"];
        if (params.strict) args.push("--strict");
        const out = run(args, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── impact ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "docrelay_impact",
    label: "DocRelay Impact",
    description:
      "Analyze which documentation sections are affected by changes to specific files. " +
      "Returns linked docs and the sync strategy for each (auto_update, mark_stale, etc.).",
    parameters: Type.Object({
      paths: Type.String({ description: "Comma-separated file paths to analyze impact for, e.g. 'src/auth.ts,docs/api.md'" }),
    }),
    promptGuidelines: [
      "Use docrelay_impact BEFORE making code changes to understand the documentation blast radius.",
      "Use docrelay_impact AFTER making code changes to identify exactly which docs need updating.",
    ],
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const paths = params.paths.split(",").map((p: string) => p.trim());
        const out = run(["impact", ...paths], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── sync ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "docrelay_sync",
    label: "DocRelay Sync",
    description:
      "Synchronize documentation for a specific symbol, or sync all stale docs. " +
      "Applies the configured strategy: auto-update inline docs, rewrite standalone docs, or mark architecture docs for review.",
    parameters: Type.Object({
      symbol: Type.Optional(Type.String({ description: "Symbol ID to sync (e.g. 'auth:login'). If omitted, sync all stale docs." })),
      allStale: Type.Optional(Type.Boolean({ description: "Sync all stale documentation (default: false)" })),
    }),
    promptGuidelines: [
      "Use docrelay_sync after renaming or refactoring a symbol to automatically update linked documentation.",
      "Use docrelay_sync with allStale=true to batch-update all documentation after a large refactor.",
    ],
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const args = ["sync"];
        if (params.symbol) args.push("--symbol", params.symbol);
        if (params.allStale) args.push("--all-stale");
        const out = run(args, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── link ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "docrelay_link",
    label: "DocRelay Link",
    description:
      "Manage symbol-to-documentation mappings. Create a manual mapping, delete one, confirm auto-generated mappings, or reject incorrect ones.",
    parameters: Type.Object({
      action: Type.String({ description: "create, delete, confirm, or reject" }),
      symbol: Type.Optional(Type.String({ description: "Symbol ID (required for create/delete)" })),
      doc: Type.Optional(Type.String({ description: "Documentation section ID (required for create/delete)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const args = ["link", params.action];
        if (params.symbol) args.push("--symbol", params.symbol);
        if (params.doc) args.push("--doc", params.doc);
        const out = run(args, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── diff ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "docrelay_diff",
    label: "DocRelay Diff",
    description:
      "View the complete change history for a symbol: when it was created, renamed, refactored, and which documentation sections were updated.",
    parameters: Type.Object({
      symbolId: Type.String({ description: "Symbol ID to show history for, e.g. 'src/auth.ts:login'" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["diff", params.symbolId], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });
}
