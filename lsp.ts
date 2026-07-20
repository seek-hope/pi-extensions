/**
 * LSP extension for pi — wraps official language servers directly.
 * Official upstreams:
 *   pyright (Python): https://github.com/microsoft/pyright
 *   clangd (C/C++):   https://github.com/clangd/clangd (LLVM)
 *   rust-analyzer:    https://github.com/rust-lang/rust-analyzer
 *   typescript-ls:    https://github.com/typescript-language-server/typescript-language-server
 *
 * Each server is invoked as a subprocess via stdio JSON-RPC.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ── minimal LSP client ──────────────────────────────────────────────────────

interface LspServer {
  id: string;
  bin: string;
  args: string[];
  languageId: string;
  rootMarkers: string[];
}

const SERVERS: Record<string, LspServer> = {
  python: {
    id: "pyright",
    bin: "pyright-langserver",
    args: ["--stdio"],
    languageId: "python",
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
  },
  cpp: {
    id: "clangd",
    bin: "clangd",
    args: ["--background-index=0"],
    languageId: "cpp",
    rootMarkers: ["compile_commands.json", ".clangd", "CMakeLists.txt", ".git"],
  },
  rust: {
    id: "rust-analyzer",
    bin: "rust-analyzer",
    args: [],
    languageId: "rust",
    rootMarkers: ["Cargo.toml", ".git"],
  },
  typescript: {
    id: "typescript-language-server",
    bin: "typescript-language-server",
    args: ["--stdio"],
    languageId: "typescript",
    rootMarkers: ["tsconfig.json", "package.json", ".git"],
  },
};

function findRoot(cwd: string, markers: string[]): string {
  let dir = cwd;
  while (true) {
    for (const m of markers) {
      if (existsSync(join(dir, m))) return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function makeId(): number {
  return Math.floor(Math.random() * 100000);
}

class LspClient {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private initialized = false;

  constructor(private server: LspServer, private root: string, private signal?: AbortSignal) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.server.bin, this.server.args, {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
      this.proc.stderr!.on("data", (chunk: Buffer) => {
        // LSP servers log to stderr; ignore for now
      });
      this.proc.on("error", reject);
      this.proc.on("exit", (code) => {
        if (!this.initialized) reject(new Error(`${this.server.id} exited with code ${code}`));
      });
      if (this.signal) {
        this.signal.addEventListener("abort", () => this.stop());
      }
      // Initialize
      this.send("initialize", {
        processId: process.pid,
        rootUri: `file://${this.root}`,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["plaintext", "markdown"] },
            definition: {},
            references: {},
          },
        },
      }).then((result) => {
        this.initialized = true;
        this.sendNotification("initialized", {});
        resolve();
      }).catch(reject);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    // Parse complete messages (LSP uses Content-Length header + \r\n\r\n + body)
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buffer.substring(0, headerEnd);
      const lengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!lengthMatch) { this.buffer = this.buffer.substring(headerEnd + 4); continue; }
      const contentLength = parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;
      const body = this.buffer.substring(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.substring(bodyStart + contentLength);
      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && msg.id !== null) {
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); p.resolve(msg.result); }
        }
      } catch {
        // ignore parse errors for partial messages
      }
    }
  }

  private sendMessage(msg: any): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.proc!.stdin!.write(header + body);
  }

  private send(method: string, params: any): Promise<any> {
    const id = makeId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  private sendNotification(method: string, params: any): void {
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  async openFile(filePath: string): Promise<void> {
    const uri = `file://${filePath}`;
    const content = require("fs").readFileSync(filePath, "utf-8");
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.server.languageId,
        version: 1,
        text: content,
      },
    });
  }

  async hover(filePath: string, line: number, character: number): Promise<string> {
    const uri = `file://${filePath}`;
    const result = await this.send("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return "No hover information available.";
    const contents = result.contents;
    if (typeof contents === "string") return contents;
    if (Array.isArray(contents)) {
      return contents.map((c: any) => (typeof c === "string" ? c : c.value || "")).join("\n");
    }
    if (contents && contents.value) return contents.value;
    return JSON.stringify(result, null, 2);
  }

  async definition(filePath: string, line: number, character: number): Promise<string> {
    const uri = `file://${filePath}`;
    const result = await this.send("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
    return JSON.stringify(result, null, 2);
  }

  async references(filePath: string, line: number, character: number): Promise<string> {
    const uri = `file://${filePath}`;
    const result = await this.send("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return JSON.stringify(result, null, 2);
  }

  async diagnostics(filePath: string): Promise<string> {
    const uri = `file://${filePath}`;
    const result = await this.send("textDocument/diagnostic", {
      textDocument: { uri },
    });
    return JSON.stringify(result, null, 2);
  }

  async stop(): Promise<void> {
    if (this.proc) {
      try { this.sendNotification("shutdown", {}); } catch { /* ignore */ }
      this.proc.kill();
      this.proc = null;
    }
  }
}

// ── tool execution ──────────────────────────────────────────────────────────

async function withLsp(
  language: string,
  filePath: string,
  ctx: any,
  signal: AbortSignal | undefined,
  fn: (client: LspClient) => Promise<string>,
): Promise<string> {
  const cfg = SERVERS[language];
  if (!cfg) return `Unknown language: ${language}. Supported: python, cpp, rust, typescript`;
  const root = findRoot(ctx.cwd, cfg.rootMarkers);
  const client = new LspClient(cfg, root, signal);
  try {
    await client.start();
    await client.openFile(filePath);
    return await fn(client);
  } finally {
    await client.stop();
  }
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get language server diagnostics for a file. Supports: python (pyright), cpp (clangd), rust (rust-analyzer), typescript (typescript-language-server).",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const text = await withLsp(params.language, params.filePath, ctx, _signal, (c) => c.diagnostics(params.filePath));
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get hover/type information at a specific position in a file",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
      line: Type.Number({ description: "Zero-based line number" }),
      character: Type.Number({ description: "Zero-based character offset on the line" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const text = await withLsp(params.language, params.filePath, ctx, _signal, (c) => c.hover(params.filePath, params.line, params.character));
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Go to Definition",
    description: "Find the definition of a symbol at a specific position",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
      line: Type.Number({ description: "Zero-based line number" }),
      character: Type.Number({ description: "Zero-based character offset on the line" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const text = await withLsp(params.language, params.filePath, ctx, _signal, (c) => c.definition(params.filePath, params.line, params.character));
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description: "Find all references to a symbol at a specific position",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
      line: Type.Number({ description: "Zero-based line number" }),
      character: Type.Number({ description: "Zero-based character offset on the line" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const text = await withLsp(params.language, params.filePath, ctx, _signal, (c) => c.references(params.filePath, params.line, params.character));
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
