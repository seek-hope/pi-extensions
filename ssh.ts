/**
 * SSH extension — persistent multiplexed connections, standard SSH syntax.
 *
 * Single persistent shell per connection for all commands. Long tasks are
 * backgrounded on the remote side (nohup) to avoid blocking.
 * File transfer uses scp/rsync via ControlMaster (no password needed).
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
  proc: ChildProcess | null;
  buf: string;
  pending: Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>;
  reqId: number;
  startTime: number;
  lastUse: number;
}

const connections = new Map<string, Connection>();

function connKey(user: string, hostname: string, port: number): string {
  return `${user}@${hostname}:${port}`;
}
function socketPath(key: string): string {
  return join(SOCKET_DIR, key.replace(/[@:]/g, "_") + ".sock");
}
function targetStr(alias: string, user: string, hostname: string, port: number): string {
  return alias !== hostname ? alias : `-p ${port} ${user}@${hostname}`;
}

function resolveSshConfig(host: string): { user: string; hostname: string; port: number } | null {
  try {
    const out = execSync(`ssh -G "${host}" 2>/dev/null`, { encoding: "utf-8", stdio: "pipe", timeout: 5_000 });
    const cfg: Record<string, string> = {};
    for (const line of out.split("\n")) { const s = line.indexOf(" "); if (s > 0) cfg[line.substring(0, s)] = line.substring(s + 1); }
    if (cfg["hostname"] && cfg["hostname"] !== host) {
      return { user: cfg["user"] || "root", hostname: cfg["hostname"], port: parseInt(cfg["port"] || "22", 10) };
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
  const r = resolveSshConfig(hostname);
  if (r) { if (!user) user = r.user; hostname = r.hostname; if (!port) port = r.port; }
  return { alias, user: user || "root", hostname, port: port || 22, command };
}

// ── persistent shell ────────────────────────────────────────────────────────

function ensureShell(conn: Connection): void {
  if (conn.proc && conn.proc.exitCode === null) {
    // Check if stdin is still writable
    if (conn.proc.stdin?.writable) return;
    // Stdin closed — process is dead, clean up
    try { conn.proc.kill(); } catch { /* ok */ }
  }
  if (conn.proc) { try { conn.proc.kill(); } catch { /* ok */ } }
  for (const [, p] of conn.pending) p.reject(new Error("Connection reset"));
  conn.pending.clear();
  conn.buf = "";
  conn.reqId = 0;

  const args = `ssh -o ControlPath="${conn.socket}" -o ConnectTimeout=5 -o LogLevel=ERROR ${conn.sshTarget}`.split(" ");
  conn.proc = spawn(args[0], args.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],  // Capture stderr too
  });

  conn.proc.stdout!.on("data", (chunk: Buffer) => {
    conn.buf += chunk.toString();
    extractResponses(conn);
  });

  conn.proc.stderr!.on("data", (chunk: Buffer) => {
    // Include stderr in output — it may contain error messages
    conn.buf += chunk.toString();
    extractResponses(conn);
  });

  conn.proc.on("exit", (code) => {
    conn.proc = null;
    for (const [, p] of conn.pending) p.reject(new Error(`SSH shell exited (code ${code})`));
    conn.pending.clear();
  });

  conn.proc.on("error", (err) => {
    conn.proc = null;
    for (const [, p] of conn.pending) p.reject(new Error(`SSH shell error: ${err.message}`));
    conn.pending.clear();
  });
}

function extractResponses(conn: Connection): void {
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
}

function shellExec(conn: Connection, cmd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    ensureShell(conn);
    if (!conn.proc || !conn.proc.stdin?.writable) {
      reject(new Error("SSH shell not available"));
      return;
    }
    const reqId = ++conn.reqId;
    conn.pending.set(reqId, { resolve, reject });
    // Pass command directly via stdin — the shell reads lines and executes them
    // Don't wrap in quotes (that would treat semicolons literally)
    // Use a heredoc-like approach: write command, then echo the marker
    const wrote = conn.proc.stdin.write(`${cmd}\necho __END__${reqId}:$?\n`);
    if (!wrote) {
      conn.pending.delete(reqId);
      reject(new Error("SSH stdin closed"));
    }
    setTimeout(() => {
      if (conn.pending.has(reqId)) { conn.pending.delete(reqId); reject(new Error("SSH command timeout")); }
    }, timeout);
  });
}

// ── connection management ───────────────────────────────────────────────────

function isConnected(key: string): boolean {
  const sock = socketPath(key);
  if (!existsSync(sock)) return false;
  try { execSync(`ssh -o ControlPath="${sock}" -O check x 2>&1`, { encoding: "utf-8", stdio: "pipe", timeout: 5_000 }); return true; }
  catch (e: any) { return /master running/i.test(e.stdout || "") || /master running/i.test(e.stderr || ""); }
}

function connect(alias: string, user: string, hostname: string, port: number, ctx: any): void {
  const key = connKey(user, hostname, port);
  const sock = socketPath(key);
  const sshTarget = targetStr(alias, user, hostname, port);
  if (isConnected(key)) {
    if (!connections.has(key)) addConn(key, alias, sock, sshTarget);
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
  ctx.ui.setStatus("ssh-" + key, `Waiting...`);
  let tries = 0;
  function poll() {
    tries++;
    if (isConnected(key)) { addConn(key, alias, sock, sshTarget); ctx.ui.setStatus("ssh-" + key, ""); ctx.ui.notify(`Connected.`, "info"); return; }
    if (tries < 10) { ctx.ui.setStatus("ssh-" + key, `Waiting... (${tries * 2}s)`); setTimeout(poll, 2000); }
    else { ctx.ui.setStatus("ssh-" + key, ""); ctx.ui.notify("Timeout.", "warning"); }
  }
  setTimeout(poll, 2000);
}

function addConn(key: string, alias: string, sock: string, target: string): void {
  connections.set(key, { key, alias, socket: sock, sshTarget: target, proc: null, buf: "", pending: new Map(), reqId: 0, startTime: Date.now(), lastUse: Date.now() });
}

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
          addConn(key, uh, sock, pt && pt !== "22" ? `-p ${pt} ${uh}` : uh);
        }
      } catch { /* not active */ }
    }
  } catch { /* empty */ }
}

function findConnection(host: string): Connection | undefined {
  syncFromDisk();
  const s = host.toLowerCase();
  for (const [, c] of connections) if (c.key.toLowerCase().includes(s) || c.alias.toLowerCase().includes(s)) return c;
  return undefined;
}

function closeConn(target: string, ctx: any): void {
  for (const [key, c] of connections) {
    if (c.key.includes(target) || c.alias.includes(target)) {
      if (c.proc) { try { c.proc.kill(); } catch { /* ok */ } }
      try { execSync(`ssh -o ControlPath="${c.socket}" -O exit x 2>/dev/null`, { stdio: "ignore" }); } catch { /* ok */ }
      try { rmSync(c.socket); } catch { /* ok */ }
      connections.delete(key);
      ctx.ui.notify(`Closed ${c.key}.`, "info");
      return;
    }
  }
  ctx.ui.notify(`No connection matching "${target}".`, "error");
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });

  // ── interceptor: block raw remote ssh ────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = ((event.input as any)?.command || "") as string;
    if (/\bsshpass\b/.test(cmd)) {
      return { block: true, reason: "sshpass blocked. Use ssh_exec or scp_to_remote/scp_from_remote." };
    }
    const words = cmd.split(/\s+/);
    const idx = words.findIndex(w => /^(?:ssh|sshpass|scp|sftp|rsync)$/.test(w));
    if (idx >= 0 && /\S+@\S+/.test(words.slice(idx, idx + 12).join(" "))) {
      return { block: true, reason: "Remote ssh/scp/rsync blocked. Use ssh_exec (commands) or scp_to_remote/scp_from_remote (files)." };
    }
  });

  // ── /ssh command ─────────────────────────────────────────────────────
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

  // ── ssh_exec ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "ssh_exec",
    label: "SSH Execute",
    description:
      "Execute a command on a remote server via persistent SSH connection. " +
      "For long-running tasks (training, builds), use the background parameter: " +
      "the command runs via nohup on the remote server and returns immediately with a log path. " +
      "Use another ssh_exec to check progress via 'cat /tmp/task.log' or 'ps aux | grep PID'.",
    promptSnippet: "Run a command on a remote server through a persistent SSH connection.",
    promptGuidelines: [
      "MANDATORY: When the user asks to run commands on a remote server, you MUST use ssh_exec instead of bash.",
      "MANDATORY: For long-running remote tasks (training, builds, downloads), set background=true. The command runs via nohup, returns a log path immediately.",
      "After background ssh_exec, use another ssh_exec to check progress: 'cat /tmp/task.log' or 'ps aux | grep PID'.",
      "Call ssh_status before running ssh_exec to verify the target host is connected.",
      "If no connection exists, tell the user: /ssh <host>",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias" }),
      command: Type.String({ description: "Command to execute on the remote server" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 60000)" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background via nohup on remote. Returns log path immediately (default: false)" })),
    }),
    async execute(_id, params, _signal) {
      syncFromDisk();
      const conn = findConnection(params.host);
      if (!conn) {
        return { content: [{ type: "text", text: `No connection matching "${params.host}". Connect: /ssh ${params.host}` }], details: {}, isError: true };
      }
      if (!isConnected(conn.key)) {
        if (conn.proc) { try { conn.proc.kill(); } catch { /* ok */ } }
        connections.delete(conn.key);
        return { content: [{ type: "text", text: `Connection stale. Reconnect: /ssh ${conn.alias}` }], details: {}, isError: true };
      }
      try {
        const isBg = params.background === true;
        if (isBg) {
          // Long-running task: wrap in nohup on remote, return immediately
          const logPath = `/tmp/pi-bg-${Date.now().toString(36)}.log`;
          const bgCmd = `nohup bash -c '${params.command.replace(/'/g, "'\\''")}' > ${logPath} 2>&1 & echo PID=$!`;
          const result = await shellExec(conn, bgCmd, 15000);
          conn.lastUse = Date.now();
          return {
            content: [{
              type: "text",
              text: `Background task started on ${conn.key}.\n` +
                `${result.trim()}\n` +
                `Log: ${logPath}\n` +
                `Check progress: ssh_exec("${conn.alias}", "tail -20 ${logPath}")\n` +
                `Check running: ssh_exec("${conn.alias}", "ps aux | grep '${params.command.substring(0, 30)}'")\n` +
                `Read full log: ssh_exec("${conn.alias}", "cat ${logPath}")`,
            }],
            details: { pid: result.trim(), logPath },
          };
        }
        const result = await shellExec(conn, params.command, Math.min(params.timeout || 60_000, 300_000));
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  // ── scp_to_remote ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "scp_to_remote",
    label: "SCP to Remote",
    description: "Copy a local file to a remote server via persistent SSH connection (no password needed).",
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias" }),
      localPath: Type.String({ description: "Local file path" }),
      remotePath: Type.String({ description: "Remote destination path (e.g. '/data/file.pt' or '/data/')" }),
    }),
    async execute(_id, params, _signal) {
      syncFromDisk();
      const conn = findConnection(params.host);
      if (!conn) return { content: [{ type: "text", text: `No connection. Connect: /ssh ${params.host}` }], details: {}, isError: true };
      if (!isConnected(conn.key)) return { content: [{ type: "text", text: "Connection stale. Reconnect." }], details: {}, isError: true };
      try {
        const target = conn.alias !== conn.key.split(":")[0]?.split("@")[1]
          ? `${conn.alias}:${params.remotePath}`  // SSH config alias
          : `-P ${conn.key.split(":")[1]} ${conn.key.split(":")[0]}:${params.remotePath}`;
        const result = execSync(
          `scp -o ControlPath="${conn.socket}" -o ConnectTimeout=5 -o LogLevel=ERROR ${params.localPath} ${target}`,
          { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 300_000 }
        );
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: `Copied: ${params.localPath} → ${conn.alias}:${params.remotePath}\n${result || "OK"}` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── scp_from_remote ───────────────────────────────────────────────────
  pi.registerTool({
    name: "scp_from_remote",
    label: "SCP from Remote",
    description: "Copy a file from a remote server to local via persistent SSH connection (no password needed).",
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias" }),
      remotePath: Type.String({ description: "Remote file path" }),
      localPath: Type.String({ description: "Local destination path" }),
    }),
    async execute(_id, params, _signal) {
      syncFromDisk();
      const conn = findConnection(params.host);
      if (!conn) return { content: [{ type: "text", text: `No connection. Connect: /ssh ${params.host}` }], details: {}, isError: true };
      if (!isConnected(conn.key)) return { content: [{ type: "text", text: "Connection stale. Reconnect." }], details: {}, isError: true };
      try {
        const target = conn.alias !== conn.key.split(":")[0]?.split("@")[1]
          ? `${conn.alias}:${params.remotePath}`
          : `-P ${conn.key.split(":")[1]} ${conn.key.split(":")[0]}:${params.remotePath}`;
        const result = execSync(
          `scp -o ControlPath="${conn.socket}" -o ConnectTimeout=5 -o LogLevel=ERROR ${target} ${params.localPath}`,
          { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 300_000 }
        );
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: `Copied: ${conn.alias}:${params.remotePath} → ${params.localPath}\n${result || "OK"}` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── ssh_status ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "ssh_status",
    label: "SSH Status",
    description: "Check active SSH connections.",
    promptSnippet: "Check active SSH connections before running remote commands.",
    promptGuidelines: ["Call ssh_status before ssh_exec to verify the target host is connected.", "If not connected, tell the user: /ssh <host>"],
    parameters: Type.Object({}),
    async execute() {
      syncFromDisk();
      if (connections.size === 0) return { content: [{ type: "text", text: "No active SSH connections." }], details: {} };
      const lines = ["Active SSH connections:"];
      for (const [, c] of connections) lines.push(`  ${isConnected(c.key) ? "🟢" : "⚫"} ${c.key}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.on("session_shutdown", () => {
    for (const [, c] of connections) { try { c.proc?.kill(); } catch { /* ok */ } }
  });
}

// ── runRemote helper ────────────────────────────────────────────────────────

function runRemote(alias: string, user: string, hostname: string, port: number, command: string, ctx: any): void {
  const key = connKey(user, hostname, port);
  if (!isConnected(key)) { ctx.ui.notify(`No connection. /ssh ${alias} first.`, "warning"); return; }
  if (!connections.has(key)) addConn(key, alias, socketPath(key), targetStr(alias, user, hostname, port));
  const conn = connections.get(key)!;
  ctx.ui.setStatus("ssh-" + key, `running...`);
  shellExec(conn, command, 120_000).then(result => {
    ctx.ui.setStatus("ssh-" + key, "");
    conn.lastUse = Date.now();
    ctx.ui.setWidget("ssh-result", [
      `┌─ ${user}@${hostname}:${port}`,
      ...result.split("\n").slice(0, 40).map((l: string) => `│ ${l.substring(0, 80)}`),
    ]);
  }).catch(e => { ctx.ui.setStatus("ssh-" + key, ""); ctx.ui.notify(`Failed: ${e.message}`, "error"); });
}

function showStatus(ctx: any): void {
  if (connections.size === 0) { ctx.ui.notify("No connections.", "info"); return; }
  ctx.ui.setWidget("ssh-status", [...connections.entries()].map(([k, c]) => `│ ${isConnected(c.key) ? "🟢" : "⚫"} ${k}`));
}
