/**
 * Graphify extension — wraps the official @sentropic/graphify CLI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

function run(args: string[]): string {
  return execFileSync("graphify", args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }).trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphify_explain",
    label: "Graphify Explain",
    description: "Explain a node and its connections in the knowledge graph",
    parameters: Type.Object({ node: Type.String({ description: "Node name or file path to explain" }) }),
    async execute(_id, params, _signal) {
      try {
        const out = run(["explain", params.node]);
        return { content: [{ type: "text", text: out || "(no result)" }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });

  pi.registerTool({
    name: "graphify_path",
    label: "Graphify Path",
    description: "Find the shortest path between two graph nodes",
    parameters: Type.Object({
      from: Type.String({ description: "Start node" }),
      to: Type.String({ description: "End node" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const out = run(["path", params.from, params.to]);
        return { content: [{ type: "text", text: out || "(no path found)" }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: e.message }], details: {}, isError: true }; }
    },
  });
}
