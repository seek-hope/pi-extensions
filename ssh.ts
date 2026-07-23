/**
 * SSH extension — persistent multiplexed connections, standard SSH syntax.
 *
 * Single persistent shell per connection for all commands. Long tasks are
 * backgrounded on the remote side (nohup) to avoid blocking.
 * File transfer uses scp/rsync via ControlMaster (no password needed).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SOCKET_DIR = join(homedir(), ".ssh", "pi-sockets");

interface PendingEntry {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  rand: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Connection {
  key: string;
  alias: string;
  socket: string;
  sshTarget: string;
  proc: ChildProcess | null;
  buf: string;
  pending: Map<number, PendingEntry>;
  reqId: number;
  startTime: number;
  lastUse: number;
}

const connections = new Map<string, Connection>();
let _sshPi: ExtensionAPI | null = null;

// Track remote bg tasks persistently
interface RemoteBgTask {
  host: string;
  logPath: string;
  cmd: string;
  pid: string | null;
  startTime: number;
  active: boolean; // whether a poll loop is currently running for this task
}
const remoteTasks: RemoteBgTask[] = [];

// Poll remote background task and inject result when done
function pollRemoteTask(conn: Connection, logPath: string, cmd: string, host: string, pid: string | null): void {
  // Prevent duplicate poll loops for the same task
  const existing = remoteTasks.find(t => t.logPath === logPath);
  if (existing) {
    if (existing.active) return; // already polling
    existing.active = true;
  } else {
    remoteTasks.push({ host, logPath, cmd, pid, startTime: Date.now(), active: true });
  }

  let lastSize = 0;
  let unchanged = 0;
  let errors = 0;
  const MAX_ERRORS = 5; // ~25s of failures before giving up
  let stopped = false;

  function cleanup() {
    if (!stopped) {
      stopped = true;
      const idx = remoteTasks.findIndex(t => t.logPath === logPath);
      if (idx >= 0) remoteTasks.splice(idx, 1);
      try { _sshPi?.ui?.setStatus?.("ssh-bg", ""); } catch { /* ok */ }
    }
  }

  function check() {
    if (stopped) return;
    // Verify connection still alive before polling
    const conn2 = findConnection(host);
    if (!conn2 || !isConnected(conn2.key)) {
      // Connection lost — task result unreachable; log path is all we can report
      if (_sshPi) {
        _sshPi.sendUserMessage([
          { type: "text", text: `[SSH background task on ${host} lost connection]` },
          { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
          { type: "text", text: `Log on remote: ${logPath}` },
        ], { deliverAs: "followUp" });
      }
      cleanup();
      return;
    }
    shellExec(conn2, `wc -c < '${logPath}' 2>/dev/null || echo 0`, 10_000).then(result => {
      if (stopped) return;
      const size = parseInt(result.trim(), 10) || 0;
      if (size === lastSize) {
        unchanged++;
        // After 5 iterations (25s) of stable file size, verify the process is truly done
        if (unchanged >= 5) {
          // Check if the background PID (if known) is still alive
          const pidCheck = pid ? `kill -0 ${pid} 2>/dev/null && echo alive || echo dead` : "echo unknown";
          shellExec(conn2, pidCheck, 8_000).then(pidResult => {
            if (stopped) return;
            const stillAlive = pidResult.trim() === "alive";
            if (stillAlive) {
              // Process still running — just slow/no output. Reset unchanged counter.
              unchanged = 0;
              try { _sshPi?.ui?.setStatus?.("ssh-bg", `🔄 SSH bg task running on ${host} (quiet)`); } catch { /* ok */ }
              setTimeout(check, 5000);
            } else {
              // Process is dead (or PID unknown and size stable for long enough)
              declareDone(conn2);
            }
          }).catch(() => {
            // PID check failed — assume done since size is stable
            declareDone(conn2);
          });
          return;
        }
      } else {
        lastSize = size;
        unchanged = 0;
        try { _sshPi?.ui?.setStatus?.("ssh-bg", `🔄 SSH bg task running on ${host}`); } catch { /* ok */ }
      }
      setTimeout(check, 5000);
    }).catch(() => {
      errors++;
      if (errors < MAX_ERRORS && !stopped) { setTimeout(check, 5000); }
      else { cleanup(); }
    });
  }

  function declareDone(c: Connection) {
    if (stopped) return;
    stopped = true;
    try { _sshPi?.ui?.setStatus?.("ssh-bg", ""); } catch { /* ok */ }
    const idx = remoteTasks.findIndex(t => t.logPath === logPath);
    if (idx >= 0) remoteTasks.splice(idx, 1);
    // Re-verify connection before fetching the log
    const conn3 = findConnection(host);
    if (!conn3 || !isConnected(conn3.key)) {
      if (_sshPi) {
        _sshPi.sendUserMessage([
          { type: "text", text: `[SSH background task completed on ${host} but connection lost]` },
          { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
          { type: "text", text: `Log on remote: ${logPath}` },
        ], { deliverAs: "followUp" });
      }
      return;
    }
    shellExec(c, `cat '${logPath}' 2>/dev/null`, 15_000).then(output => {
      if (_sshPi) {
        _sshPi.sendUserMessage([
          { type: "text", text: `[SSH background task completed on ${host}]` },
          { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
          { type: "text", text: `Output:\n${output.substring(0, 4000)}` },
        ], { deliverAs: "followUp" });
      }
    }).catch(() => {});
  }

  setTimeout(check, 3000);
}

function connKey(user: string, hostname: string, port: number): string {
  return `${user}@${hostname}:${port}`;
}
function socketPath(key: string): string {
  // Use @ and : directly in the filename — both are valid on Linux.
  // Old code replaced them with _, which broke usernames containing _.
  return join(SOCKET_DIR, key + ".sock");
}
function targetStr(alias: string, user: string, hostname: string, port: number): string {
  return alias !== hostname ? alias : `-p ${port} ${user}@${hostname}`;
}

function resolveSshConfig(host: string): { user: string; hostname: string; port: number } | null {
  try {
    // Use spawnSync with args array — no shell, no injection risk
    const result = spawnSync("ssh", ["-G", host], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    const out = (result.stdout || "") + (result.stderr || "");
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
    if (p === "-p") {
      if (i + 1 < parts.length) { const v = parseInt(parts[i + 1]); if (!isNaN(v)) port = v; i += 2; }
      else { i++; } // -p at end: skip it
    }
    else if (p.startsWith("-")) {
      // Consume option and its value (if next token doesn't look like another flag)
      if (i + 1 < parts.length && !parts[i + 1].startsWith("-")) { i += 2; }
      else { i += 1; }
    }
    else if (p.includes("@")) {
      // Split on the LAST @ for user/host boundary (user may contain @ in rare cases)
      const atIdx = p.lastIndexOf("@");
      user = p.substring(0, atIdx);
      const hostPart = p.substring(atIdx + 1);
      if (hostPart.includes(":")) {
        const colonIdx = hostPart.lastIndexOf(":");
        hostname = hostPart.substring(0, colonIdx);
        const pt = parseInt(hostPart.substring(colonIdx + 1));
        if (!isNaN(pt)) port = port || pt;
        else hostname = hostPart; // colon but no valid port — treat as hostname
      } else hostname = hostPart;
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
  // Already alive — don't reset
  if (conn.proc && conn.proc.exitCode === null && conn.proc.stdin?.writable) return;

  // Clean up dead/dying proc
  if (conn.proc) {
    conn.proc.removeAllListeners();
    try { conn.proc.kill(); } catch { /* ok */ }
    conn.proc = null;
  }
  // Reject stale pending promises and clear their timers
  for (const [, p] of conn.pending) {
    if (p.timer) clearTimeout(p.timer);
    p.reject(new Error("Connection reset"));
  }
  conn.pending.clear();
  conn.buf = "";
  conn.reqId = 0;

  const args = [
    "ssh",
    "-o", `ControlPath=${conn.socket}`,
    "-o", "ConnectTimeout=5",
    "-o", "LogLevel=ERROR",
    ...conn.sshTarget.split(" "),
  ];
  conn.proc = spawn(args[0], args.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
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
    for (const [, p] of conn.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`SSH shell exited (code ${code})`));
    }
    conn.pending.clear();
  });

  conn.proc.on("error", (err) => {
    conn.proc = null;
    for (const [, p] of conn.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`SSH shell error: ${err.message}`));
    }
    conn.pending.clear();
  });
}

function extractResponses(conn: Connection): void {
  // Safety: if buffer grows too large without a valid marker, truncate from front
  const MAX_BUF = 2 * 1024 * 1024; // 2 MB
  if (conn.buf.length > MAX_BUF) {
    // Find the last valid marker or keep the most recent data
    const lastMarker = conn.buf.lastIndexOf("__END__");
    if (lastMarker > 0) {
      // Discard everything before the last marker (stale data)
      conn.buf = conn.buf.substring(lastMarker);
    } else {
      // No marker at all — keep the most recent 1 MB to avoid losing a pending marker
      const keep = Math.floor(MAX_BUF / 2);
      conn.buf = conn.buf.substring(conn.buf.length - keep);
    }
  }
  while (true) {
    const m = conn.buf.match(/__END__(\d+)_(\w+):(\d+)\n/);
    if (!m) break;
    const idx = conn.buf.indexOf(m[0]);
    const output = conn.buf.substring(0, idx);
    conn.buf = conn.buf.substring(idx + m[0].length);
    const reqId = parseInt(m[1]);
    const rand = m[2];
    const p = conn.pending.get(reqId);
    // Validate the random token to prevent marker injection from command output
    if (p && p.rand === rand) {
      conn.pending.delete(reqId);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(output);
    }
  }
}

function shellExec(conn: Connection, cmd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    ensureShell(conn);
    // Re-check: the process may have exited between ensureShell and now
    if (!conn.proc || conn.proc.exitCode !== null || !conn.proc.stdin?.writable) {
      reject(new Error("SSH shell not available"));
      return;
    }
    const reqId = ++conn.reqId;
    const rand = Math.random().toString(36).slice(2, 10);
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      done(() => {
        if (conn.pending.has(reqId)) {
          const entry = conn.pending.get(reqId)!;
          conn.pending.delete(reqId);
          if (entry.timer) clearTimeout(entry.timer);
          const partial = conn.buf;
          entry.reject(new Error(`SSH command timeout after ${timeout / 1000}s. Partial output: ${partial.substring(0, 1000)}`));
        }
      });
    }, timeout);

    // Wire up a one-shot error handler on stdin to catch pipe errors
    const onStdinError = (err: Error) => {
      done(() => {
        clearTimeout(timer);
        conn.pending.delete(reqId);
        reject(new Error(`SSH stdin error: ${err.message}`));
      });
    };
    conn.proc.stdin!.once("error", onStdinError);

    conn.pending.set(reqId, { resolve, reject, rand, timer });

    // Pass command directly via stdin — the shell reads lines and executes them
    // Don't wrap in quotes (that would treat semicolons literally)
    try {
      const wrote = conn.proc.stdin!.write(`${cmd}\necho __END__${reqId}_${rand}:$?\n`);
      if (!wrote) {
        // Backpressure: wait for drain, but also listen for errors during drain
        conn.proc.stdin!.once("drain", () => {
          // Data flushed successfully — response will arrive via extractResponses
          conn.proc.stdin!.removeListener("error", onStdinError);
        });
        // If the process dies during drain, the exit handler on the proc will reject
      } else {
        conn.proc.stdin!.removeListener("error", onStdinError);
      }
    } catch (writeErr: any) {
      done(() => {
        clearTimeout(timer);
        conn.pending.delete(reqId);
        reject(new Error(`SSH write failed: ${writeErr.message}`));
      });
    }
  });
}

// ── connection management ───────────────────────────────────────────────────

function isConnected(key: string): boolean {
  // Try new format first (user@host:port.sock), then legacy (_-encoded)
  let sock = socketPath(key);
  if (!existsSync(sock)) {
    const legacySock = join(SOCKET_DIR, key.replace(/[@:]/g, "_") + ".sock");
    if (existsSync(legacySock)) sock = legacySock;
    else return false;
  }
  try {
    const result = spawnSync("ssh", ["-o", `ControlPath=${sock}`, "-O", "check", "x"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000
    });
    if (result.status === 0) return true;
    const combined = (result.stdout || "") + (result.stderr || "");
    return /master running/i.test(combined);
  }
  catch { return false; }
}

function connect(alias: string, user: string, hostname: string, port: number, ctx: any): void {
  const key = connKey(user, hostname, port);
  const sock = socketPath(key);
  const sshTarget = targetStr(alias, user, hostname, port);
  // Re-check right before connecting (master may have died since last check)
  const alreadyUp = isConnected(key);
  if (alreadyUp) {
    if (!connections.has(key)) addConn(key, alias, sock, sshTarget);
    ctx.ui.notify(`Already connected to ${user}@${hostname}:${port}.`, "info");
    return;
  }
  // Dead socket lingering — clean up
  if (existsSync(sock)) { try { rmSync(sock); } catch { /* ok */ } }
  ctx.ui.notify(`Opening SSH to ${user}@${hostname}:${port}...`, "info");
  const displayHost = alias !== hostname ? `${alias} (${user}@${hostname}:${port})` : `${user}@${hostname}:${port}`;
  const termProc = spawn("alacritty", ["-e", "bash", "-c",
    `echo "Connecting to ${displayHost}..."; ` +
    `ssh -o ControlPath="${sock}" -o ControlMaster=auto -o ControlPersist=12h ` +
    `-o ServerAliveInterval=60 -o ServerAliveCountMax=5 ` +
    `-o StrictHostKeyChecking=accept-new -fN ${sshTarget} && ` +
    `echo "Connected!" || echo "Auth failed."; read -p 'Press Enter...'`
  ], { stdio: "ignore", detached: true });
  termProc.unref();
  let connectPolling = true;
  termProc.on("error", () => {
    connectPolling = false;
    ctx.ui.setStatus("ssh-" + key, "");
    ctx.ui.notify("Failed to open terminal (alacritty not found?). Use ssh from an external terminal.", "warning");
  });
  ctx.ui.setStatus("ssh-" + key, `Waiting...`);
  let tries = 0;
  function poll() {
    if (!connectPolling) return;
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
  const raw = name.replace(/\.sock$/, "");
  // New format (user@host:port — contains both @ and :)
  if (raw.includes("@") && raw.includes(":")) return raw;
  // Legacy format (user_host_port — underscore-encoded); fragile with _ in username
  const i1 = raw.indexOf("_"), i2 = raw.lastIndexOf("_");
  if (i1 < 0 || i2 <= i1) return raw;
  return `${raw.substring(0, i1)}@${raw.substring(i1 + 1, i2)}:${raw.substring(i2 + 1)}`;
}

function syncFromDisk(): void {
  if (!existsSync(SOCKET_DIR)) return;
  try {
    const entries = readdirSync(SOCKET_DIR);
    for (const name of entries) {
      if (!name.endsWith(".sock")) continue;
      const sock = join(SOCKET_DIR, name);
      try {
        // Quick check with short timeout
        const result = spawnSync("ssh", ["-O", "check", "-o", `ControlPath=${sock}`, "x"], {
          encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000
        });
        const combined = (result.stdout || "") + (result.stderr || "");
        if (result.status !== 0 && !/master running/i.test(combined)) {
          // Master dead — clean up stale socket
          try { rmSync(sock); } catch { /* ok */ }
          continue;
        }
        const key = keyFromFilename(name);
        if (![...connections.values()].some(c => c.socket === sock)) {
          const [uh, pt] = key.split(":");
          addConn(key, uh, sock, pt && pt !== "22" ? `-p ${pt} ${uh}` : uh);
        }
      } catch {
        // ssh -O check timed out — socket likely stale, clean up
        try { rmSync(sock); } catch { /* ok */ }
      }
    }
  } catch { /* empty */ }
}

function findConnection(host: string): Connection | undefined {
  syncFromDisk();
  const s = host.toLowerCase();
  // Exact match first: alias or key
  for (const [, c] of connections) {
    if (c.alias.toLowerCase() === s || c.key.toLowerCase() === s) return c;
  }
  // Substring match as fallback
  for (const [, c] of connections) {
    if (c.key.toLowerCase().includes(s) || c.alias.toLowerCase().includes(s)) return c;
  }
  return undefined;
}

function closeConn(target: string, ctx: any): void {
  const t = target.toLowerCase();
  // Empty target matches everything via substring — reject early
  if (!t) {
    ctx.ui.notify(`Usage: /ssh close <host>. Provide a hostname or alias.`, "warning");
    return;
  }
  // Exact match on alias or key first (case-insensitive)
  for (const [key, c] of connections) {
    if (c.alias.toLowerCase() === t || c.key.toLowerCase() === t) {
      destroyConn(key, c, ctx);
      return;
    }
  }
  // Fallback: substring match — require exactly one match to avoid ambiguity
  const substringMatches: Array<[string, Connection]> = [];
  for (const [key, c] of connections) {
    if (c.key.toLowerCase().includes(t) || c.alias.toLowerCase().includes(t)) {
      substringMatches.push([key, c]);
    }
  }
  if (substringMatches.length === 1) {
    const [key, c] = substringMatches[0];
    destroyConn(key, c, ctx);
    return;
  }
  if (substringMatches.length > 1) {
    const names = substringMatches.map(([, c]) => c.key).join(", ");
    ctx.ui.notify(`Ambiguous: "${target}" matches multiple connections (${names}). Be more specific.`, "warning");
    return;
  }
  ctx.ui.notify(`No connection matching "${target}".`, "error");
}

function destroyConn(key: string, c: Connection, ctx: any): void {
  if (c.proc) { try { c.proc.kill(); } catch { /* ok */ } }
  for (const [, p] of c.pending) {
    if (p.timer) clearTimeout(p.timer);
    try { p.reject(new Error("Connection closed")); } catch { /* ok */ }
  }
  c.pending.clear();
  let masterExited = false;
  try {
    const r = spawnSync("ssh", ["-o", `ControlPath=${c.socket}`, "-O", "exit", "x"], { stdio: "ignore", timeout: 10_000 });
    masterExited = r.status === 0;
  } catch { /* timeout or spawn error — master may still be running */ }
  // Only delete the socket if the master was successfully exited.
  // If exit failed/timeout, leave the socket so the master can still be managed.
  if (masterExited || !existsSync(c.socket)) {
    try { rmSync(c.socket); } catch { /* ok */ }
  }
  connections.delete(key);
  // Also clean up any remote tasks tied to this host
  for (let i = remoteTasks.length - 1; i >= 0; i--) {
    if (remoteTasks[i].host === c.alias || remoteTasks[i].host === c.key) {
      remoteTasks.splice(i, 1);
    }
  }
  ctx.ui.notify(`Closed ${c.key}.`, "info");
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  _sshPi = pi;

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
      "MANDATORY: Commands with timeout >300s are automatically run in background (nohup). Set timeout <=300000 to run synchronously.",
      "After background ssh_exec, use another ssh_exec to check progress: 'cat /tmp/task.log' or 'ps aux | grep PID'.",
      "Call ssh_status before running ssh_exec to verify the target host is connected.",
      "If no connection exists, tell the user: /ssh <host>",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias" }),
      command: Type.String({ description: "Command to execute on the remote server" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 120000 = 2 min)" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background via nohup on remote. Returns log path immediately (default: false)" })),
    }),
    async execute(_id, params, _signal) {
      // Block sleep — SSH is persistent, no warmup needed; pollRemoteTask auto-delivers bg results
      if (/^\s*sleep\s+\d/.test(params.command)) {
        return {
          content: [{ type: "text", text: "sleep is unnecessary. SSH connections are persistent — just run the actual command directly. For bg tasks, the system auto-polls and delivers results." }],
          details: { blocked: true },
        };
      }

      syncFromDisk();
      const conn = findConnection(params.host);
      if (!conn) {
        return { content: [{ type: "text", text: `No connection matching "${params.host}". Connect: /ssh ${params.host}` }], details: {}, isError: true };
      }
      if (!isConnected(conn.key)) {
        if (conn.proc) { try { conn.proc.kill(); } catch { /* ok */ } }
        connections.delete(conn.key);
        // Clean up stale socket
        try { rmSync(conn.socket); } catch { /* ok */ }
        return { content: [{ type: "text", text: `Connection stale. Reconnect: /ssh ${conn.alias}` }], details: {}, isError: true };
      }
      try {
        const isLong = (params.timeout || 120_000) > 300_000;
        const isBg = params.background === true || isLong;

        if (isBg) {
          // Deduplicate: if same command already running on this host, return existing
          const existing = remoteTasks.find(t => t.host === params.host && t.cmd === params.command);
          if (existing) {
            return {
              content: [{
                type: "text",
                text: `Background task already running on ${conn!.key}.\\n` +
                  `Log: ${existing.logPath}\\n` +
                  `Check progress: ssh_exec("${params.host}", "tail -20 ${existing.logPath}")`,
              }],
              details: { logPath: existing.logPath, deduplicated: true },
            };
          }

          // Long-running task: register BEFORE await to prevent concurrent dedup misses
          const logPath = `/tmp/pi-bg-${Date.now().toString(36)}.log`;
          remoteTasks.push({ host: params.host, logPath, cmd: params.command, pid: null, startTime: Date.now(), active: false });

          const bgCmd = `nohup bash -c '${params.command.replace(/'/g, "'\\''")}' > ${logPath} 2>&1 & echo PID=$!`;
          const result = await shellExec(conn, bgCmd, 15000);
          conn.lastUse = Date.now();

          // Extract PID from result for liveness checks during polling
          const pidMatch = result.match(/PID=(\d+)/);
          const pid = pidMatch ? pidMatch[1] : null;

          // Poll remote log and inject result when done
          pollRemoteTask(conn, logPath, params.command, params.host, pid);

          return {
            content: [{
              type: "text",
              text: `Background task started on ${conn.key}.\n` +
                `${result.trim()}\n` +
                `Log: ${logPath}\n` +
                `Check progress: ssh_exec("${params.host}", "tail -20 ${logPath}")\n` +
                `Read full log: ssh_exec("${params.host}", "cat '${logPath}'")`,
            }],
            details: { pid: result.trim(), logPath },
          };
        }
        const result = await shellExec(conn, params.command, Math.min(params.timeout || 120_000, 600_000));
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
        // ControlMaster handles the connection — just use alias:path
        const scpArgs = [
          "-o", `ControlPath=${conn.socket}`,
          "-o", "ConnectTimeout=5",
          "-o", "LogLevel=ERROR",
          params.localPath,
          `${conn.alias}:${params.remotePath}`,
        ];
        const result = spawnSync("scp", scpArgs, {
          encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 300_000, stdio: ["ignore", "pipe", "pipe"]
        });
        if (result.status !== 0) throw new Error(result.stderr || `scp exited with code ${result.status}`);
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: `Copied: ${params.localPath} → ${conn.alias}:${params.remotePath}\n${result.stdout || "OK"}` }], details: {} };
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
        // ControlMaster handles the connection — just use alias:path
        const scpArgs = [
          "-o", `ControlPath=${conn.socket}`,
          "-o", "ConnectTimeout=5",
          "-o", "LogLevel=ERROR",
          `${conn.alias}:${params.remotePath}`,
          params.localPath,
        ];
        const result = spawnSync("scp", scpArgs, {
          encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 300_000, stdio: ["ignore", "pipe", "pipe"]
        });
        if (result.status !== 0) throw new Error(result.stderr || `scp exited with code ${result.status}`);
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: `Copied: ${conn.alias}:${params.remotePath} → ${params.localPath}\n${result.stdout || "OK"}` }], details: {} };
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

  // ── session_start: recover running remote tasks ─────────────────
  pi.on("session_start", async () => {
    syncFromDisk();
    const now = Date.now();
    const MAX_TASK_AGE = 60 * 60 * 1000; // 1 hour — older tasks are considered stale
    // Build a set of logPaths to remove (avoids findIndex-in-loop fragility)
    const toRemove = new Set<string>();
    for (const t of remoteTasks) {
      if (now - t.startTime > MAX_TASK_AGE) {
        toRemove.add(t.logPath);
        continue;
      }
      const conn = findConnection(t.host);
      if (conn && isConnected(conn.key)) {
        // Reset active flag so pollRemoteTask starts a fresh loop
        t.active = false;
        pollRemoteTask(conn, t.logPath, t.cmd, t.host, t.pid);
      } else {
        toRemove.add(t.logPath);
      }
    }
    // Batch-remove stale/orphaned tasks
    if (toRemove.size > 0) {
      for (let i = remoteTasks.length - 1; i >= 0; i--) {
        if (toRemove.has(remoteTasks[i].logPath)) remoteTasks.splice(i, 1);
      }
      // Clear status if no tasks remain
      if (remoteTasks.length === 0) {
        try { _sshPi?.ui?.setStatus?.("ssh-bg", ""); } catch { /* ok */ }
      }
    }
  });

  pi.on("session_shutdown", () => {
    for (const [, c] of connections) {
      try { c.proc?.kill(); } catch { /* ok */ }
      // Reject any pending promises so they don't hang
      for (const [, p] of c.pending) {
        if (p.timer) clearTimeout(p.timer);
        try { p.reject(new Error("Session shutdown")); } catch { /* ok */ }
      }
      c.pending.clear();
    }
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
      `┌─ ${user}@${hostname}:${port} — ${command.substring(0, 40)}`,
      ...result.split("\n").slice(0, 8).map((l: string) => `│ ${l.substring(0, 100)}`),
      result.split("\n").length > 8 ? `│ ... (/read log for full output)` : "",
    ].filter(Boolean));
  }).catch(e => { ctx.ui.setStatus("ssh-" + key, ""); ctx.ui.notify(`Failed: ${e.message}`, "error"); });
}

function showStatus(ctx: any): void {
  if (connections.size === 0) { ctx.ui.notify("No connections.", "info"); return; }
  ctx.ui.setWidget("ssh-status", [...connections.entries()].map(([k, c]) => `│ ${isConnected(c.key) ? "🟢" : "⚫"} ${k}`));
}
