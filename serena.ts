/**
 * Serena extension — MCP-first integration via serena start-mcp-server.
 * Official upstream: https://github.com/serena-ai/serena
 *
 * Starts Serena's MCP server as a persistent subprocess, communicates
 * via JSON-RPC 2.0 over stdio (MCP protocol), and registers all
 * Serena tools as native pi tools.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── MCP client ──────────────────────────────────────────────────────────────

let proc: ChildProcess | null = null;
let messageId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = "";
let ready = false;
let initPromise: Promise<void> | null = null;

function findProjectRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (existsSync(join(dir, ".serena"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function nextId(): number {
  return ++messageId;
}

function sendMessage(msg: any): void {
  if (!proc?.stdin?.writable) return;
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  proc.stdin.write(header + body);
}

function mcpRequest(method: string, params?: any): Promise<any> {
  const id = nextId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendMessage({ jsonrpc: "2.0", id, method, params: params || {} });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }
    }, 30_000);
  });
}

function mcpNotify(method: string, params?: any): void {
  sendMessage({ jsonrpc: "2.0", method, params: params || {} });
}

function onData(chunk: Buffer): void {
  if (typeof buffer !== "string") return;
  try {
    buffer += chunk.toString();
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buffer.substring(0, headerEnd);
      const m = header.match(/Content-Length: (\d+)/i);
      if (!m) { buffer = buffer.substring(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.substring(bodyStart, bodyStart + len);
      buffer = buffer.substring(bodyStart + len);
      const msg = JSON.parse(body);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  } catch { /* silently ignore */ }
}

async function startServer(cwd: string): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    const root = findProjectRoot(cwd);
    proc = spawn("serena", ["start-mcp-server", "--project", root], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", (chunk: Buffer) => {
      // Serena may log to stderr during startup; check for URL
      const text = chunk.toString();
      if (text.includes("error") || text.includes("Error")) {
        console.error("[serena]", text.trim());
      }
    });

    proc.on("error", (err) => {
      ready = false;
      initPromise = null;
      reject(err);
    });
    // Permanent no-op handler to prevent unhandled error crashes
    proc.on("error", () => {});

    proc.on("exit", (code) => {
      ready = false;
      initPromise = null;
      if (code !== 0) {
        // Don't reject — will retry on next tool call
      }
    });

    // Initialize MCP
    mcpRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-coding-agent", version: "1.0.0" },
    }).then(() => {
      mcpNotify("initialized", {});
      ready = true;
      resolve();
    }).catch(reject);

    setTimeout(() => {
      if (!ready) {
        reject(new Error("Serena MCP server failed to start in 20s"));
      }
    }, 20_000);
  });

  return initPromise;
}

function stopServer(): void {
  if (proc) {
    // Remove data listeners but KEEP error handler
    proc.stdout?.removeAllListeners("data");
    proc.stderr?.removeAllListeners("data");
    try { mcpNotify("shutdown", {}); } catch { /* ok */ }
    proc.kill();
    proc = null;
    ready = false;
    initPromise = null;
  }
}

// ── tool execution helper ──────────────────────────────────────────────────

async function callSerenaTool(toolName: string, args: Record<string, any>, cwd: string): Promise<string> {
  await startServer(cwd);
  const result = await mcpRequest("tools/call", {
    name: toolName,
    arguments: args,
  });
  // Extract text content from MCP result
  const content = result?.content || result;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return JSON.stringify(result, null, 2);
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── tool registration: key serena tools ──────────────────────────────

  const tools: Array<{
    name: string;
    label: string;
    description: string;
    params: Record<string, any>;
    required?: string[];
  }> = [
    {
      name: "serena_find_symbol",
      label: "Serena Find Symbol",
      description: "Find a code symbol using Serena semantic search via LSP backend.",
      params: {
        query: Type.String({ description: "Symbol name or partial name to search" }),
        relativePath: Type.Optional(Type.String({ description: "Limit search to a specific relative path" })),
        includeBody: Type.Optional(Type.Boolean({ description: "Include symbol body in results (default: false)" })),
      },
    },
    {
      name: "serena_find_references",
      label: "Serena Find References",
      description: "Find all references to a symbol using Serena's LSP backend.",
      params: {
        symbol: Type.String({ description: "Symbol name to find references for" }),
        relativePath: Type.Optional(Type.String({ description: "File containing the symbol" })),
      },
    },
    {
      name: "serena_search_pattern",
      label: "Serena Search Pattern",
      description: "Search for a text/regex pattern across the project using Serena.",
      params: {
        pattern: Type.String({ description: "Text or regex pattern to search" }),
        relativePath: Type.Optional(Type.String({ description: "Limit search path" })),
        caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive search (default: false)" })),
      },
    },
    {
      name: "serena_overview",
      label: "Serena Overview",
      description: "Get a structural overview of top-level symbols in a file.",
      params: {
        relativePath: Type.String({ description: "File path relative to project root" }),
      },
    },
    {
      name: "serena_diagnostics",
      label: "Serena Diagnostics",
      description: "Get LSP diagnostics for a file, grouped by severity.",
      params: {
        relativePath: Type.String({ description: "File path relative to project root" }),
      },
    },
    {
      name: "serena_find_definition",
      label: "Serena Find Definition",
      description: "Find the declaration/definition of a symbol.",
      params: {
        query: Type.String({ description: "Symbol name to find definition for" }),
        relativePath: Type.Optional(Type.String({ description: "File containing the symbol reference" })),
      },
    },
    {
      name: "serena_rename_symbol",
      label: "Serena Rename Symbol",
      description: "Rename a symbol throughout the codebase using LSP refactoring.",
      params: {
        symbol: Type.String({ description: "Current symbol name" }),
        newName: Type.String({ description: "New name for the symbol" }),
        relativePath: Type.Optional(Type.String({ description: "File containing the symbol" })),
      },
    },
    {
      name: "serena_onboarding",
      label: "Serena Onboarding",
      description: "Perform project onboarding — identify structure, build tasks, test commands.",
      params: {},
    },
    {
      name: "serena_get_config",
      label: "Serena Get Config",
      description: "Print the current Serena configuration: active project, tools, contexts, modes.",
      params: {},
    },
  ];

  // Register mapped tools — pi tool name → serena MCP tool name
  const toolNameMap: Record<string, string> = {
    serena_find_symbol: "find_symbol",
    serena_find_references: "find_referencing_symbols",
    serena_search_pattern: "search_for_pattern",
    serena_overview: "get_symbols_overview",
    serena_diagnostics: "get_diagnostics_for_file",
    serena_find_definition: "find_declaration",
    serena_rename_symbol: "rename_symbol",
    serena_onboarding: "onboarding",
    serena_get_config: "get_current_config",
  };

  for (const t of tools) {
    const paramSchema: Record<string, any> = {};
    for (const [key, type] of Object.entries(t.params)) {
      paramSchema[key] = type;
    }
    const serenaToolName = toolNameMap[t.name] || t.name.replace("serena_", "");
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: Type.Object(paramSchema),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          // Map pi param names to serena param names
          const serenaParams: Record<string, any> = {};
          for (const [key, value] of Object.entries(params)) {
            // Handle param name mapping
            if (key === "query" && t.name === "serena_find_definition") {
              serenaParams["query"] = value;
            } else {
              serenaParams[key] = value;
            }
          }
          const result = await callSerenaTool(serenaToolName, serenaParams, ctx.cwd);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
        }
      },
    });
  }

  // ── session shutdown cleanup ───────────────────────────────────────
  pi.on("session_shutdown", () => {
    stopServer();
  });
}
