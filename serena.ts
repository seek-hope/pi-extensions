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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── MCP client ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

interface ServerState {
  child: ChildProcessWithoutNullStreams;
  root: string;
  buffer: Buffer;
  ready: boolean;
  closed: boolean;
  termination: Promise<void> | null;
}

interface PendingRequest {
  state: ServerState;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

let server: ServerState | null = null;
let initialization: { state: ServerState; promise: Promise<void> } | null = null;
let messageId = 0;
const pending = new Map<number | string, PendingRequest>();
let startMutex: Promise<void> = Promise.resolve();

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

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.length > 0) return new Error(error);
  try {
    const detail = JSON.stringify(error);
    return new Error(detail && detail !== "{}" ? detail : fallback);
  } catch {
    return new Error(fallback);
  }
}

function sendMessage(state: ServerState, msg: unknown): void {
  const { child } = state;
  if (
    state.closed
    || child.exitCode !== null
    || child.signalCode !== null
    || !child.stdin.writable
    || child.stdin.destroyed
    || child.stdin.writableEnded
  ) {
    throw new Error("Serena MCP server is not running");
  }

  const body = JSON.stringify(msg);
  if (body === undefined) throw new Error("Cannot serialize MCP message");
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  child.stdin.write(header + body);
}

function takePending(id: number | string): PendingRequest | undefined {
  const request = pending.get(id);
  if (!request) return undefined;

  pending.delete(id);
  clearTimeout(request.timeout);
  if (request.signal && request.onAbort) {
    request.signal.removeEventListener("abort", request.onAbort);
  }
  return request;
}

function rejectPendingForState(state: ServerState, error: Error): void {
  for (const [id, request] of pending) {
    if (request.state !== state) continue;
    takePending(id)?.reject(error);
  }
}

function mcpRequest(
  state: ServerState,
  method: string,
  params?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  const id = nextId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const request = takePending(id);
      if (request) {
        request.reject(new Error(`Serena MCP request timed out: ${method}`));
      }
    }, timeoutMs);

    const request: PendingRequest = { state, method, resolve, reject, timeout, signal };
    if (signal) {
      request.onAbort = () => {
        const aborted = takePending(id);
        if (!aborted) return;
        aborted.reject(new Error(`Serena MCP request cancelled: ${method}`));
        try {
          sendMessage(state, {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: "Client cancelled the tool call" },
          });
        } catch {
          // The transport failure will be reported by the original request path.
        }
      };
      signal.addEventListener("abort", request.onAbort, { once: true });
    }

    // Register in pending map AFTER sendMessage to avoid a TOCTOU race:
    // if the child process exits immediately after sendMessage writes to stdin,
    // the exit handler fires asynchronously and rejects the request via
    // rejectPendingForState. By adding to pending only after sendMessage
    // succeeds, we ensure the request is either:
    //   a) rejected synchronously by the catch block, or
    //   b) the message was sent and the request is safely in the pending map
    //      for the exit handler to find and reject if the child crashes.
    if (signal?.aborted) {
      clearTimeout(timeout);
      reject(new Error(`Serena MCP request cancelled before send: ${method}`));
      return;
    }

    try {
      sendMessage(state, { jsonrpc: "2.0", id, method, params: params ?? {} });
    } catch (error) {
      clearTimeout(timeout);
      reject(asError(error, `Failed to send Serena MCP request: ${method}`));
      return;
    }

    // Message sent successfully — now register the pending request.
    // The response (or an exit-handler rejection) will arrive on a subsequent
    // event-loop tick, so there is no race between registration and delivery.
    pending.set(id, request);
    if (signal?.aborted) {
      const aborted = takePending(id);
      if (aborted) aborted.reject(new Error(`Serena MCP request cancelled: ${method}`));
    }
  });
}

function mcpNotify(state: ServerState, method: string, params?: unknown): void {
  try {
    sendMessage(state, { jsonrpc: "2.0", method, params: params ?? {} });
  } catch {
    // Notifications are fire-and-forget; a closed transport is not an error.
  }
}

function protocolFailure(state: ServerState, error: Error): void {
  // Avoid console.error in TUI context — errors propagate via pending
  // request rejections and the exit handler.
  void terminateServerState(state, error);
}

function handleMessage(state: ServerState, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    protocolFailure(state, new Error("Serena MCP server sent an invalid JSON-RPC message"));
    return;
  }

  const msg = value as Record<string, unknown>;
  if (typeof msg.method === "string") {
    // Per JSON-RPC 2.0 §4.1: The Server MUST NOT reply to a Notification.
    // Notifications have id === null or id === undefined. Skip responses.
    if (typeof msg.id === "number" || typeof msg.id === "string") {
      try {
        if (msg.method === "ping") {
          sendMessage(state, { jsonrpc: "2.0", id: msg.id, result: {} });
        } else {
          sendMessage(state, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `Unsupported server request: ${msg.method}` },
          });
        }
      } catch (error) {
        protocolFailure(state, asError(error, "Failed to answer Serena MCP server request"));
      }
    }
    return;
  }

  // Accept both number and string IDs (JSON-RPC 2.0 spec allows both)
  if (typeof msg.id !== "number" && typeof msg.id !== "string") return;
  const request = takePending(msg.id);
  if (!request) return;

  if (msg.error !== undefined && msg.error !== null) {
    const rpcError = msg.error as { message?: unknown };
    const message = typeof rpcError?.message === "string"
      ? rpcError.message
      : JSON.stringify(msg.error);
    request.reject(new Error(message || `Serena MCP request failed: ${request.method}`));
  } else {
    request.resolve(msg.result);
  }
}

function onData(state: ServerState, chunk: Buffer | string): void {
  if (state.closed) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.buffer = state.buffer.length === 0 ? bytes : Buffer.concat([state.buffer, bytes]);

  while (!state.closed) {
    const headerEnd = state.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (state.buffer.length > MAX_HEADER_BYTES) {
        protocolFailure(state, new Error("Serena MCP response header exceeded the size limit"));
      }
      return;
    }

    if (headerEnd > MAX_HEADER_BYTES) {
      protocolFailure(state, new Error("Serena MCP response header exceeded the size limit"));
      return;
    }

    const header = state.buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i);
    if (!match) {
      protocolFailure(state, new Error("Serena MCP response is missing Content-Length"));
      return;
    }

    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
      protocolFailure(state, new Error(`Invalid Serena MCP Content-Length: ${match[1]}`));
      return;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (state.buffer.length < bodyEnd) return;

    const body = state.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    state.buffer = state.buffer.subarray(bodyEnd);
    try {
      handleMessage(state, JSON.parse(body));
    } catch (error) {
      protocolFailure(state, asError(error, "Serena MCP server sent invalid JSON"));
      return;
    }
  }
}

function deactivateServerState(state: ServerState, error: Error): void {
  if (state.closed) return;
  state.closed = true;
  state.ready = false;
  state.buffer = Buffer.alloc(0);
  state.child.stdout.removeAllListeners("data");
  state.child.stderr.removeAllListeners("data");
  state.child.stdin.removeAllListeners("error");
  state.child.removeAllListeners("exit");
  state.child.removeAllListeners("error");
  rejectPendingForState(state, error);

  if (server === state) server = null;
  if (initialization?.state === state) initialization = null;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
  });
}

function terminateServerState(state: ServerState, error: Error): Promise<void> {
  deactivateServerState(state, error);
  if (state.termination) return state.termination;

  state.termination = (async () => {
    if (hasExited(state.child)) return;

    try { state.child.stdin.end(); } catch { /* continue to signals */ }
    if (await waitForExit(state.child, 750)) return;

    try { state.child.kill("SIGTERM"); } catch { /* continue to SIGKILL */ }
    if (await waitForExit(state.child, 1_500)) return;

    try { state.child.kill("SIGKILL"); } catch { /* report below */ }
    if (!(await waitForExit(state.child, 1_000))) {
      // Process did not exit; it will be left to the OS to clean up.
    }
  })();
  return state.termination;
}

function createServerState(root: string): ServerState {
  const child = spawn("serena", ["start-mcp-server", "--project", root], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state: ServerState = {
    child,
    root,
    buffer: Buffer.alloc(0),
    ready: false,
    closed: false,
    termination: null,
  };

  child.stdout.on("data", (chunk: Buffer) => onData(state, chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    // Serena may write diagnostics to stderr; errors are already surfaced
    // through protocol failures and promise rejections, so we avoid
    // console.error here to prevent TUI corruption.
  });

  const onStreamError = (error: Error) => {
    if (!state.closed) void terminateServerState(state, error);
  };
  child.stdin.on("error", onStreamError);
  child.stdout.on("error", onStreamError);
  child.stderr.on("error", onStreamError);
  child.once("error", (error) => {
    if (!state.closed) void terminateServerState(state, error);
  });
  child.once("exit", (code, signal) => {
    if (state.closed) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    deactivateServerState(state, new Error(`Serena MCP server exited unexpectedly (${detail})`));
  });

  return state;
}

async function startServer(cwd: string): Promise<void> {
  const root = findProjectRoot(cwd);
  if (server?.root === root && server.ready && !server.closed) return;
  if (initialization?.state.root === root) return initialization.promise;

  // Serialise startup & teardown to prevent races where two callers both
  // see server === null and both spawn a child, leaking one process.
  const prevMutex = startMutex;
  let releaseMutex: () => void;
  startMutex = new Promise<void>((r) => { releaseMutex = r; });

  try {
    await prevMutex;

    // Re-check now that we hold the lock.
    if (server?.root === root && server.ready && !server.closed) return;
    if (initialization?.state.root === root) return initialization.promise;

    if (server) {
      await terminateServerState(server, new Error("Serena MCP server project changed"));
    }

    const state = createServerState(root);
    server = state;
    const promise = (async () => {
      try {
        await mcpRequest(state, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pi-coding-agent", version: "1.0.0" },
        }, INITIALIZE_TIMEOUT_MS);
        mcpNotify(state, "initialized", {});
        state.ready = true;
      } catch (error) {
        const initError = asError(error, "Failed to initialize Serena MCP server");
        await terminateServerState(state, initError);
        throw initError;
      } finally {
        if (initialization?.state === state) initialization = null;
      }
    })();
    initialization = { state, promise };
    return promise;
  } finally {
    releaseMutex!();
  }
}

async function stopServer(): Promise<void> {
  const state = server;
  if (!state) return;
  await terminateServerState(state, new Error("Serena MCP server stopped"));
}

// ── tool execution helper ──────────────────────────────────────────────────

function extractToolText(result: unknown): string {
  const content = result && typeof result === "object" && !Array.isArray(result)
    ? (result as { content?: unknown }).content
    : undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((item): item is { type: "text"; text: string } => (
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string"
      ))
      .map((item) => item.text)
      .join("\n");
    if (text || content.length === 0) return text;
  }

  const serialized = JSON.stringify(result, null, 2);
  return serialized ?? String(result ?? "");
}

async function callSerenaTool(
  toolName: string,
  args: Record<string, any>,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  await startServer(cwd);
  const state = server;
  if (!state?.ready || state.closed) throw new Error("Serena MCP server is not ready");

  const result = await mcpRequest(state, "tools/call", {
    name: toolName,
    arguments: args,
  }, REQUEST_TIMEOUT_MS, signal);
  const text = extractToolText(result);
  if (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && (result as { isError?: unknown }).isError === true
  ) {
    throw new Error(text || `Serena tool failed: ${toolName}`);
  }
  return text;
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
    serena_rename_symbol: "rename_symbol",
    serena_onboarding: "onboarding",
    serena_get_config: "get_current_config",
  };

  // Map pi camelCase param names to Serena snake_case param names.
  const paramNameMap: Record<string, string> = {
    query: "name_path_pattern",
    relativePath: "relative_path",
    includeBody: "include_body",
    symbol: "name_path",
    newName: "new_name",
    pattern: "substring_pattern",
  };

  // Tools where the caseSensitive flag should be applied when false
  // by prepending "(?i)" to the regex pattern.
  const caseInsensitiveTools = new Set(["serena_search_pattern"]);

  for (const t of tools) {
    const paramSchema: Record<string, any> = {};
    for (const [key, type] of Object.entries(t.params)) {
      paramSchema[key] = type;
    }
    const serenaToolName = toolNameMap[t.name] || t.name.replace("serena_", "");
    const toolName = t.name;
    pi.registerTool({
      name: toolName,
      label: t.label,
      description: t.description,
      parameters: Type.Object(paramSchema),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        try {
          // Map pi param names to serena param names
          const serenaParams: Record<string, any> = {};
          for (const [key, value] of Object.entries(params)) {
            if (value === undefined) continue;
            // caseSensitive is handled separately below; never forwarded.
            if (key === "caseSensitive") continue;
            const mapped = paramNameMap[key] || key;
            serenaParams[mapped] = value;
          }
          // Apply caseSensitive flag for regex-based search tools.
          if (caseInsensitiveTools.has(toolName) && params.caseSensitive === false) {
            const patternKey = paramNameMap["pattern"] || "substring_pattern";
            if (typeof serenaParams[patternKey] === "string") {
              serenaParams[patternKey] = "(?i)" + serenaParams[patternKey];
            }
          }
          const result = await callSerenaTool(serenaToolName, serenaParams, ctx.cwd, signal);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
        }
      },
    });
  }

  // ── session shutdown cleanup ───────────────────────────────────────
  pi.on("session_shutdown", async () => {
    try {
      await stopServer();
    } catch { /* best-effort shutdown */ }
  });
}
