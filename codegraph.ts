/**
 * CodeGraph extension for pi — wraps the official @colbymchenry/codegraph CLI.
 * Official upstream: https://github.com/colbymchenry/codegraph
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

const BIN = "codegraph";

function run(args: string[], cwd: string): string {
  return execFileSync(BIN, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Check CodeGraph index status for the current project",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["status"], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_search",
    label: "CodeGraph Search",
    description: "Search symbols by name using CodeGraph",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name to search for" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["search", params.query], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description: "Explore code structure and architecture with CodeGraph",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Natural language query about code structure" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const args = ["explore"];
      if (params.query) args.push(params.query);
      try {
        const out = run(args, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find all callers of a symbol",
    parameters: Type.Object({
      symbol: Type.String({ description: "Fully qualified symbol name" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["callers", params.symbol], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find all callees (outbound calls) of a symbol",
    parameters: Type.Object({
      symbol: Type.String({ description: "Fully qualified symbol name" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["callees", params.symbol], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze transitive change impact for a symbol",
    parameters: Type.Object({
      symbol: Type.String({ description: "Fully qualified symbol name" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["impact", params.symbol], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });
}
