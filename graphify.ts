/**
 * Graphify extension for pi — wraps the official @sentropic/graphify CLI.
 * Official upstream: https://github.com/Graphify-Labs/graphify
 * Requires: graphify CLI installed on PATH
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

const BIN = "graphify";

function run(args: string[], cwd: string): string {
  return execSync([BIN, ...args].join(" "), {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphify_build",
    label: "Graphify Build",
    description: "Build or incrementally update the Graphify knowledge graph for the current project",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["build"], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "graphify_query",
    label: "Graphify Query",
    description: "Ask a natural-language question against the Graphify knowledge graph",
    parameters: Type.Object({
      question: Type.String({ description: "Natural language question about the codebase" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["query", params.question], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "graphify_explain",
    label: "Graphify Explain",
    description: "Explain a node and its connections in the knowledge graph",
    parameters: Type.Object({
      node: Type.String({ description: "Node name or file path to explain" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["explain", params.node], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "graphify_impact",
    label: "Graphify Impact",
    description: "Show the blast radius of changes to one or more files",
    parameters: Type.Object({
      paths: Type.String({ description: "Comma-separated file paths to analyze impact for" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const out = run(["affected", ...params.paths.split(",").map((p: string) => p.trim())], ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "graphify_status",
    label: "Graphify Status",
    description: "Check whether the Graphify knowledge graph exists and is healthy",
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
}
