/**
 * Graphify extension — wraps the official @sentropic/graphify CLI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";

function run(args: string[]): string {
  const result = spawnSync("graphify", args, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });

  if (result.error) {
    // ENOENT (not installed), EACCES, etc.
    const hint = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? " — is graphify installed and on PATH?"
      : "";
    throw new Error(`graphify failed: ${result.error.message}${hint}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `graphify exited with code ${result.status}`);
  }

  return (result.stdout ?? "").trim();
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
      } catch (e: any) {
        return { content: [{ type: "text", text: `graphify explain failed: ${e.message}` }], details: {}, isError: true };
      }
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
      } catch (e: any) {
        return { content: [{ type: "text", text: `graphify path failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });
}
