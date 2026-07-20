/**
 * SSH extension — persistent multiplexed connections, standard SSH syntax.
 *
 * Uses a single persistent ssh process per connection (stdin/stdout pipe).
 * All commands flow through this one session — no MaxSessions limit.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync, spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SOCKET_DIR = join(homedir(), ".ssh", "pi-sockets");

interface Connection {
  key: string;
  alias: string;
  socket: string;
  sshTarget: string;
  proc: ChildProcess | null;   // persistent shell process
  buf: string;
  pending: Map<number, { resolve: (v: string) => void }>;
  reqId: number;
  startTime: number;
  lastUse: number;
}

const connections = new Map<string, Connection>();

// ── helpers ─────────────────────────────────────────────────────────────────

function connKey(user: string, hostname: string, port: number): string {
  return `${user}@${hostname}:${port}`;
}

function socketPath(key: string): string {
  return join(SOCKET_DIR, key.replace(/[@:]/g, "_") + ".sock");
}

function isConnected(key: string): boolean {
  const sock = socketPath(key);
  if (!existsSync(sock)) return false;
  try {
    execSync(`ssh -o ControlPath="${sock}" -O check x 2>&1`, {
      encoding: "utf-8", stdio: "pipe", timeout: 5_000,
    });
    return true;
  } catch (e: any) {
    return /master running/i.test(e.stdout || "") || /master running/i.test(e.stderr || "");
  }
}

function resolveSshConfig(host: string): { user: string; hostname: string; port: number } | null {
  try {
    const out = execSync(`ssh -G "${host}" 2>/dev/null`, {
      encoding: "utf-8", stdio: "pipe", timeout: 5_000,
    });
    const cfg: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const s = line.indexOf(" ");
      if (s > 0) cfg[line.substring(0, s)] = line.substring(s + 1);
    }
    if (cfg["hostname"] && cfg["hostname"] !== host) {
      return {
        user: cfg["user"] || "root",
        hostname: cfg["hostname"],
        port: parseInt(cfg["port"] || "22", 10),
      };
    }
    return null;
  } catch { return null; }
}

function parseArgs(args: string): { alias: string; user: string; hostname: string; port: number; command: string } | null {
  const parts = args.trim().split(/\s+/);
  let user = "", hostname = "", port = 0, command = "", i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p === "-p" && i + 1 < parts.length) { port = parseInt(parts[i + 1]); i += 2; }
    else if (p.startsWith("-")) { i += (i + 1 < parts.length && !parts[i + 1].startsWith("-")) ? 2 : 1; }
    else if (p.includes("@")) {
      const [u, h] = p.split("@"); user = u;
      if (h.includes(":")) { const [hn, pt] = h.split(":"); hostname = hn; port = port || parseInt(pt); }
      else hostname = h;
      if (i + 1 < parts.length) command = parts.slice(i + 1).join(" ");
      i = parts.length;
    } else { hostname = p; if (i + 1 < parts.length) command = parts.slice(i + 1).join(" "); i = parts.length; }
  }
  if (!hostname) return null;
  const alias = hostname;
  const resolved = resolveSshConfig(hostname);
  if (resolved) { if (!user) user = resolved.user; hostname = resolved.hostname; if (!port) port = resolved.port; }
  return { alias, user: user || "root", hostname, port: port || 22, command };
}

function targetStr(alias: string, user: string, hostname: string, port: number): string {
  return alias !== hostname ? alias : `-p ${port} ${user}@${hostname}`;
}

// ── persistent shell process ───────────────────────────────────────────────

function ensureShell(conn: Connection): void {
  if (conn.proc && !conn.proc.killed) return;

  const args = `ssh -o ControlPath="${conn.socket}" -o ConnectTimeout=5 -o LogLevel=ERROR ${conn.sshTarget}`.split(" ");
  conn.proc = spawn(args[0], args.slice(1), {
    stdio: ["pipe", "pipe", "ignore"],
  });
  conn.buf = "";
  conn.pending = new Map();
  conn.reqId = 0;

  conn.proc.stdout!.on("data", (chunk: Buffer) => {
    conn.buf += chunk.toString();
    // Process completed requests (marked by __END__<id>:<exit>)
    while (true) {
      const m = conn.buf.match(/__END__(\d+):(\d+)\n/);
      if (!m) break;
      const idx = conn.buf.indexOf(m[0]);
      const output = conn.buf.substring(0, idx);
      conn.buf = conn.buf.substring(idx + m[0].length);
      const reqId = parseInt(m[1]);
      const p = conn.pending.get(reqId);
      if (p) { conn.pending.delete(reqId); p.resolve(output); }
    }
  });

  conn.proc.on("exit", () => {
    conn.proc = null;
    // Reject all pending
    for (const [, p] of conn.pending) p.reject(new Error("SSH shell died"));
    conn.pending.clear();
  });
}

function shellExec(conn: Connection, cmd: string, timeout: number): Promise<string> {
  ensureShell(conn);
  const reqId = ++conn.reqId;
  return new Promise((resolve, reject) => {
    conn.pending.set(reqId, { resolve, reject });
    // Escape single quotes in cmd
    const safeCmd = cmd.replace(/'/g, "'\\''");
    conn.proc!.stdin!.write(`'${safeCmd}'; echo __END__${reqId}:$?\n`);
    setTimeout(() => {
      if (conn.pending.has(reqId)) {
        conn.pending.delete(reqId);
        reject(new Error("SSH command timeout"));
      }
    }, timeout);
  });
}

function killShell(conn: Connection): void {
  if (conn.proc) { conn.proc.kill(); conn.proc = null; }
}

// ── connect ─────────────────────────────────────────────────────────────────

function connect(alias: string, user: string, hostname: string, port: number, ctx: any): void {
  const key = connKey(user, hostname, port);
  const sock = socketPath(key);
  const sshTarget = targetStr(alias, user, hostname, port);

  if (isConnected(key)) {
    if (!connections.has(key)) {
      connections.set(key, { key, alias, socket: sock, sshTarget, proc: null, buf: "", pending: new Map(), reqId: 0, startTime: Date.now(), lastUse: Date.now() });
    }
    ctx.ui.notify(`Already connected to ${user}@${hostname}:${port}.`, "info");
    return;
  }

  ctx.ui.notify(`Opening SSH to ${user}@${hostname}:${port}...`, "info");
  const displayHost = alias !== hostname ? `${alias} (${user}@${hostname}:${port})` : `${user}@${hostname}:${port}`;
  spawn("alacritty", ["-e", "bash", "-c",
    `echo "Connecting to ${displayHost}..."; ` +
    `ssh -o ControlPath="${sock}" -o ControlMaster=auto -o ControlPersist=2h ` +
    `-o ServerAliveInterval=60 -o ServerAliveCountMax=5 ` +
    `-o StrictHostKeyChecking=accept-new -fN ${sshTarget} && ` +
    `echo "Connected!" || echo "Auth failed."; read -p 'Press Enter...'`
  ], { stdio: "ignore", detached: true }).unref();

  ctx.ui.setStatus("ssh-" + key, `Waiting for ${user}@${hostname}...`);
  let tries = 0;
  function poll() {
    tries++;
    if (isConnected(key)) {
      connections.set(key, { key, alias, socket: sock, sshTarget, proc: null, buf: "", pending: new Map(), reqId: 0, startTime: Date.now(), lastUse: Date.now() });
      ctx.ui.setStatus("ssh-" + key, "");
      ctx.ui.notify(`Connected to ${user}@${hostname}:${port}.`, "info");
      return;
    }
    if (tries < 10) { ctx.ui.setStatus("ssh-" + key, `Waiting... (${tries * 2}s)`); setTimeout(poll, 2000); }
    else { ctx.ui.setStatus("ssh-" + key, ""); ctx.ui.notify("Timeout. /ssh status to check.", "warning"); }
  }
  setTimeout(poll, 2000);
}

// ── sync/helpers ────────────────────────────────────────────────────────────

function keyFromFilename(name: string): string {
  const raw = name.replace(".sock", "");
  const i1 = raw.indexOf("_"), i2 = raw.lastIndexOf("_");
  if (i1 < 0 || i2 <= i1) return raw;
  return `${raw.substring(0, i1)}@${raw.substring(i1 + 1, i2)}:${raw.substring(i2 + 1)}`;
}

function syncFromDisk(): void {
  if (!existsSync(SOCKET_DIR)) return;
  try {
    for (const name of execSync(`ls "${SOCKET_DIR}" 2>/dev/null || true`, { encoding: "utf-8" }).split("\n")) {
      if (!name.endsWith(".sock")) continue;
      const sock = join(SOCKET_DIR, name);
      try {
        execSync(`ssh -O check -o ControlPath="${sock}" x 2>&1`, { encoding: "utf-8", stdio: "pipe", timeout: 3_000 });
        const key = keyFromFilename(name);
        if (![...connections.values()].some(c => c.socket === sock)) {
          const [uh, pt] = key.split(":");
          const sshTarget = pt && pt !== "22" ? `-p ${pt} ${uh}` : uh;
          connections.set(key, { key, alias: uh, socket: sock, sshTarget, proc: null, buf: "", pending: new Map(), reqId: 0, startTime: Date.now(), lastUse: Date.now() });
        }
      } catch { /* not active */ }
    }
  } catch { /* empty */ }
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = ((event.input as any)?.command || "") as string;
    if (/\bsshpass\b/.test(cmd)) {
      return { block: true, reason: "sshpass blocked. Use ssh_exec(host, command). First: /ssh <host>" };
    }
    const words = cmd.split(/\s+/);
    const idx = words.findIndex(w => /^(?:ssh|sshpass|scp|sftp|rsync)$/.test(w));
    if (idx >= 0 && /\S+@\S+/.test(words.slice(idx, idx + 12).join(" "))) {
      return { block: true, reason: "Remote ssh blocked. Use ssh_exec(host, command). First: /ssh <host>" };
    }
  });

  pi.registerCommand("ssh", {
    description: "SSH with persistent connections. /ssh [-p PORT] user@host [command]  |  status  |  close <host>",
    handler: async (args, ctx) => {
      if (!args?.trim()) { ctx.ui.notify("/ssh [-p PORT] user@host [command]", "warning"); return; }
      if (args.trim() === "status") { syncFromDisk(); showStatus(ctx); return; }
      if (args.trim().startsWith("close ")) { closeConn(args.trim().slice(6).trim(), ctx); return; }
      const p = parseArgs(args);
      if (!p) { ctx.ui.notify("Invalid syntax.", "error"); return; }
      if (p.command) {
        runRemote(p.alias, p.user, p.hostname, p.port, p.command, ctx);
      } else {
        connect(p.alias, p.user, p.hostname, p.port, ctx);
      }
    },
  });

  pi.registerTool({
    name: "ssh_exec",
    label: "SSH Execute",
    description: "Run a command on a remote server through a persistent SSH connection.",
    promptSnippet: "Run a command on a remote server through a persistent SSH connection.",
    promptGuidelines: [
      "MANDATORY: When the user asks to run commands on a remote server, you MUST use ssh_exec instead of bash.",
      "Call ssh_status before running ssh_exec to verify the target host is connected.",
      "If no SSH connection exists, tell the user to run /ssh <host> first.",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias" }),
      command: Type.String({ description: "Command to execute on the remote server" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 60000)" })),
    }),
    async execute(_id, params, _signal) {
      syncFromDisk();
      const host = params.host, cmd = params.command;
      const timeout = Math.min(params.timeout || 60_000, 300_000);
      const conn = findConnection(host);
      if (!conn) {
        return { content: [{ type: "text", text: `No active connection matching "${host}". Connect: /ssh ${host}` }], details: {}, isError: true };
      }
      if (!isConnected(conn.key)) {
        killShell(conn); connections.delete(conn.key);
        return { content: [{ type: "text", text: `Connection stale. Reconnect: /ssh ${conn.alias}` }], details: {}, isError: true };
      }
      try {
        const result = await shellExec(conn, cmd, timeout);
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "ssh_status",
    label: "SSH Status",
    description: "Check which SSH hosts are configured and which have active persistent connections.",
    promptSnippet: "Check active SSH connections before running remote commands.",
    promptGuidelines: ["Call ssh_status before ssh_exec to verify the target host is connected.", "If not connected, tell the user: /ssh <host>"],
    parameters: Type.Object({}),
    async execute() {
      syncFromDisk();
      if (connections.size === 0) {
        return { content: [{ type: "text", text: "No active SSH connections." }], details: {} };
      }
      const lines = ["Active SSH connections:"];
      for (const [, c] of connections) {
        lines.push(`  ${isConnected(c.key) ? "🟢" : "⚫"} ${c.key} (${((Date.now() - c.startTime) / 60000).toFixed(0)} min)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.on("session_shutdown", () => {
    for (const [, c] of connections) killShell(c);
    // Keep connections map — sockets persist across sessions
  });
}

// ── run remote via persistent shell ─────────────────────────────────────────

function runRemote(alias: string, user: string, hostname: string, port: number, command: string, ctx: any): void {
  const key = connKey(user, hostname, port);
  if (!isConnected(key)) { ctx.ui.notify(`No connection. /ssh ${alias} first.`, "warning"); return; }
  if (!connections.has(key)) {
    const sock = socketPath(key);
    connections.set(key, { key, alias, socket: sock, sshTarget: targetStr(alias, user, hostname, port), proc: null, buf: "", pending: new Map(), reqId: 0, startTime: Date.now(), lastUse: Date.now() });
  }
  const conn = connections.get(key)!;
  ctx.ui.setStatus("ssh-" + key, `running...`);
  shellExec(conn, command, 120_000).then(result => {
    ctx.ui.setStatus("ssh-" + key, "");
    conn.lastUse = Date.now();
    ctx.ui.setWidget("ssh-result", [
      `┌─ ${user}@${hostname}:${port}`,
      ...result.split("\n").slice(0, 40).map((l: string) => `│ ${l.substring(0, 80)}`),
      `└──`.replace(/_/g, "─"),
    ]);
  }).catch(e => {
    ctx.ui.setStatus("ssh-" + key, "");
    ctx.ui.notify(`Failed: ${e.message}`, "error");
  });
}

function findConnection(host: string): Connection | undefined {
  syncFromDisk();
  const s = host.toLowerCase();
  for (const [, c] of connections) if (c.key.toLowerCase().includes(s) || c.alias.toLowerCase().includes(s)) return c;
  return undefined;
}

function showStatus(ctx: any): void {
  if (connections.size === 0) { ctx.ui.notify("No connections.", "info"); return; }
  ctx.ui.setWidget("ssh-status", [...connections.entries()].map(([k, c]) =>
    `│ ${isConnected(c.key) ? "🟢" : "⚫"} ${k}`
  ));
}

function closeConn(target: string, ctx: any): void {
  for (const [key, c] of connections) {
    if (c.key.includes(target) || c.alias.includes(target)) {
      killShell(c);
      execSync(`ssh -o ControlPath="${c.socket}" -O exit x 2>/dev/null`, { stdio: "ignore" });
      try { rmSync(c.socket); } catch { /* ok */ }
      connections.delete(key);
      ctx.ui.notify(`Closed ${c.key}.`, "info");
      return;
    }
  }
  ctx.ui.notify(`No connection matching "${target}".`, "error");
}
