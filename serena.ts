/**
 * Serena extension for pi — wraps the official serena-agent via its MCP server.
 * Official upstream: https://github.com/serena-ai/serena
 *
 * Uses serena's project server (HTTP API) for code intelligence operations.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let serverProc: ChildProcess | null = null;
let serverUrl = "";

function findGitRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

async function ensureServer(cwd: string, signal?: AbortSignal): Promise<string> {
  if (serverProc && serverUrl) return serverUrl;

  const root = findGitRoot(cwd);
  return new Promise((resolve, reject) => {
    serverProc = spawn("serena", ["start-project-server", "--project", root], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    serverProc.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      // Serena project server prints the URL on startup
      const match = output.match(/https?:\/\/[^\s]+/);
      if (match) {
        serverUrl = match[0];
        resolve(serverUrl);
      }
    });

    serverProc.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/https?:\/\/[^\s]+/);
      if (match && !serverUrl) {
        serverUrl = match[0];
        resolve(serverUrl);
      }
    });

    serverProc.on("error", reject);
    serverProc.on("exit", (code) => {
      if (!serverUrl) reject(new Error(`Serena server exited with code ${code}`));
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        serverProc?.kill();
        serverProc = null;
        serverUrl = "";
      });
    }

    setTimeout(() => {
      if (!serverUrl) reject(new Error("Serena server failed to start in time"));
    }, 20_000);
  });
}

async function serenaRequest(endpoint: string, body: any, cwd: string, signal?: AbortSignal): Promise<string> {
  const baseUrl = await ensureServer(cwd, signal);
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    if (serverProc) {
      serverProc.kill();
      serverProc = null;
      serverUrl = "";
    }
  });

  pi.registerTool({
    name: "serena_find_symbol",
    label: "Serena Find Symbol",
    description: "Find a code symbol using Serena semantic search",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name to search" }),
      relativePath: Type.Optional(Type.String({ description: "Limit search to a specific relative path" })),
      includeBody: Type.Optional(Type.Boolean({ description: "Include symbol body in results (default: false)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await serenaRequest("/find-symbol", {
          query: params.query,
          relativePath: params.relativePath || "",
          includeBody: params.includeBody || false,
        }, ctx.cwd, _signal);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "serena_find_references",
    label: "Serena Find References",
    description: "Find all references to a symbol using Serena",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to find references for" }),
      relativePath: Type.Optional(Type.String({ description: "File containing the symbol" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await serenaRequest("/find-referencing-symbols", {
          symbol: params.symbol,
          relativePath: params.relativePath || "",
        }, ctx.cwd, _signal);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "serena_search_pattern",
    label: "Serena Search Pattern",
    description: "Search for a text/regex pattern across the codebase using Serena",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or regex pattern to search" }),
      relativePath: Type.Optional(Type.String({ description: "Limit search path" })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive search (default: false)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await serenaRequest("/search-for-pattern", {
          pattern: params.pattern,
          relativePath: params.relativePath || "",
          caseSensitive: params.caseSensitive || false,
        }, ctx.cwd, _signal);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "serena_overview",
    label: "Serena Overview",
    description: "Get a structural overview of symbols in a file using Serena",
    parameters: Type.Object({
      relativePath: Type.String({ description: "File path relative to project root" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await serenaRequest("/get-symbols-overview", {
          relativePath: params.relativePath,
        }, ctx.cwd, _signal);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "serena_diagnostics",
    label: "Serena Diagnostics",
    description: "Get LSP diagnostics for a file using Serena",
    parameters: Type.Object({
      relativePath: Type.String({ description: "File path relative to project root" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await serenaRequest("/get-diagnostics-for-file", {
          relativePath: params.relativePath,
        }, ctx.cwd, _signal);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
