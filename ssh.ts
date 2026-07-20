/**
 * SSH extension — persistent multiplexed connections, standard SSH syntax.
 *
 * Security: passwords/passphrases entered interactively via separate terminal.
 * Connection state: ControlMaster sockets on disk, metadata in memory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SOCKET_DIR = join(homedir(), ".ssh", "pi-sockets");

interface Connection {
  key: string;
  alias: string;
  socket: string;
  sshTarget: string;   // argument for ssh command (alias or "-p PORT user@host")
  startTime: number;
  lastUse: number;
}

const connections = new Map<string, Connection>();

// ── helpers ─────────────────────────────────────────────────────────────────

function connKey(user: string, hostname: string, port: number): string {
  return `${user}@${hostname}:${port}`;
}

function socketPath(key: string): string {
  // Replace @ and : with _, keep dots for hostnames
  return join(SOCKET_DIR, key.replace(/[@:]/g, "_") + ".sock");
}

function isConnected(key: string): boolean {
  const sock = socketPath(key);
  if (!existsSync(sock)) return false;
  try {
    execSync(`ssh -O check -o ControlPath="${sock}" x 2>&1`, {
      encoding: "utf-8", stdio: "pipe", timeout: 5_000,
    });
    return true;
  } catch (e: any) {
    return /master running/i.test(e.stdout || "") || /master running/i.test(e.stderr || "");
  }
}

function keyFromFilename(name: string): string {
  // Reverse socketPath: user_hostname_port.sock → user@hostname:port
  const raw = name.replace(".sock", "");
  const idx1 = raw.indexOf("_");
  const idx2 = raw.lastIndexOf("_");
  if (idx1 < 0 || idx2 <= idx1) return raw; // can't parse, return as-is
  const user = raw.substring(0, idx1);
  const hostname = raw.substring(idx1 + 1, idx2);
  const port = raw.substring(idx2 + 1);
  return `${user}@${hostname}:${port}`;
}

// Recover connections from existing sockets on disk
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
          // Reconstruct SSH target from filename
          const [userHost, portStr] = key.split(":");
          const sshTarget = portStr && portStr !== "22"
            ? `-p ${portStr} ${userHost}`
            : userHost;
          connections.set(key, { key, alias: userHost, socket: sock, startTime: Date.now(), lastUse: Date.now(), sshTarget });
        }
      } catch { /* socket not active */ }
    }
  } catch { /* dir empty or error */ }
}

function sh(cmd: string, timeout = 60_000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    return e.stderr || e.message || "";
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
  } catch {
    return null;
  }
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
    } else {
      hostname = p;
      if (i + 1 < parts.length) command = parts.slice(i + 1).join(" ");
      i = parts.length;
    }
  }
  if (!hostname) return null;

  const alias = hostname;
  const resolved = resolveSshConfig(hostname);
  if (resolved) {
    if (!user) user = resolved.user;
    hostname = resolved.hostname;
    if (!port) port = resolved.port;
  }
  return { alias, user: user || "root", hostname, port: port || 22, command };
}

// ── connect ─────────────────────────────────────────────────────────────────

function connect(alias: string, user: string, hostname: string, port: number, ctx: any): void {
  const key = connKey(user, hostname, port);
  const sock = socketPath(key);
  const sshTarget = alias !== hostname ? alias : `-p ${port} ${user}@${hostname}`;

  // Restore or connect
  if (isConnected(key)) {
    connections.set(key, { key, alias, socket: sock, startTime: Date.now(), lastUse: Date.now(), sshTarget });
    ctx.ui.notify(`Already connected to ${user}@${hostname}:${port}.`, "info");
    return;
  }

  ctx.ui.notify(`Opening SSH to ${user}@${hostname}:${port}...`, "info");

  const displayHost = alias !== hostname ? `${alias} (${user}@${hostname}:${port})` : `${user}@${hostname}:${port}`;
  spawn("alacritty", ["-e", "bash", "-c",
    `echo "Connecting to ${displayHost}..."; ` +
    `ssh -o ControlPath="${sock}" -o ControlMaster=auto -o ControlPersist=2h ` +
    `-o ServerAliveInterval=60 -o ServerAliveCountMax=5 -o MaxSessions=20 ` +
    `-o StrictHostKeyChecking=accept-new -fN ${sshTarget} && ` +
    `echo "Connected! You may close this window." || echo "Auth failed."; ` +
    `read -p 'Press Enter to close...'`
  ], { stdio: "ignore", detached: true }).unref();

  ctx.ui.setStatus("ssh-" + key, `Waiting for ${user}@${hostname}...`);

  let tries = 0;
  function poll() {
    tries++;
    if (isConnected(key)) {
      connections.set(key, { key, alias, socket: sock, startTime: Date.now(), lastUse: Date.now(), sshTarget });
      ctx.ui.setStatus("ssh-" + key, "");
      ctx.ui.notify(`Connected to ${user}@${hostname}:${port}.`, "info");
      return;
    }
    if (tries < 10) { ctx.ui.setStatus("ssh-" + key, `Waiting for ${user}@${hostname}... (${tries * 2}s)`); setTimeout(poll, 2000); }
    else { ctx.ui.setStatus("ssh-" + key, ""); ctx.ui.notify(`Timeout. Run /ssh status to check.`, "warning"); }
  }
  setTimeout(poll, 2000);
}

// ── execute remote command ─────────────────────────────────────────────────

function runRemote(key: string, sock: string, alias: string, command: string, user: string, hostname: string, port: number, ctx: any): void {
  if (!isConnected(key)) {
    ctx.ui.notify(`No connection to ${user}@${hostname}:${port}. /ssh ${alias} first.`, "warning");
    return;
  }
  if (!connections.has(key)) {
    connections.set(key, { key, alias, socket: sock, startTime: Date.now(), lastUse: Date.now(), sshTarget });
  }

  ctx.ui.setStatus("ssh-" + key, `running on ${user}@${hostname}...`);
  const sshTarget = alias !== hostname ? alias : `-p ${port} ${user}@${hostname}`;
  const result = sh(`ssh -o ControlPath="${sock}" -o ConnectTimeout=5 -o LogLevel=ERROR ${sshTarget} '${command.replace(/'/g, "'\\''")}'`, 120_000);
  ctx.ui.setStatus("ssh-" + key, "");
  connections.get(key)!.lastUse = Date.now();

  ctx.ui.setWidget("ssh-result", [
    `┌─ ${user}@${hostname}:${port} ─────────────────────`,
    `│ ${command.substring(0, 60)}`,
    `├──────────────────────────────────────────`,
    ...result.split("\n").slice(0, 40).map((l: string) => `│ ${l.substring(0, 80)}`),
    result.split("\n").length > 40 ? `│ ...` : "",
    `└──────────────────────────────────────────`,
  ].filter(Boolean));
}

// ── find connection for AI tool ────────────────────────────────────────────

function findConnection(host: string): Connection | undefined {
  syncFromDisk();
  const s = host.toLowerCase();
  for (const [, c] of connections) {
    if (c.key.toLowerCase().includes(s) || c.alias.toLowerCase().includes(s)) return c;
  }
  return undefined;
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });

  // ── interceptor: block raw remote ssh ────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = ((event.input as any)?.command || "") as string;

    if (/\bsshpass\b/.test(cmd)) {
      return { block: true, reason: "sshpass blocked. Use ssh_exec(host, command). First: /ssh <host>" };
    }
    // Block only when the remote target is the SSH argument (within first ~10 words)
    const words = cmd.split(/\s+/);
    const sshIdx = words.findIndex(w => /^(?:ssh|sshpass|scp|sftp|rsync)$/.test(w));
    if (sshIdx >= 0) {
      // Check the next few words for user@host pattern
      const nearby = words.slice(sshIdx, sshIdx + 12).join(" ");
      if (/\S+@\S+/.test(nearby)) {
        return { block: true, reason: "Remote ssh blocked. Use ssh_exec(host, command). First: /ssh <host>" };
      }
    }
  });

  // ── /ssh command ─────────────────────────────────────────────────────
  pi.registerCommand("ssh", {
    description: "SSH with persistent connections. /ssh [-p PORT] user@host [command]  |  status  |  close <host>",
    handler: async (args, ctx) => {
      if (!args?.trim()) { ctx.ui.notify("Usage: /ssh [-p PORT] user@host [command]", "warning"); return; }
      if (args.trim() === "status") { showStatus(ctx); return; }
      if (args.trim().startsWith("close ")) { closeConn(args.trim().slice(6).trim(), ctx); return; }

      const p = parseArgs(args);
      if (!p) { ctx.ui.notify("Invalid syntax.", "error"); return; }

      const key = connKey(p.user, p.hostname, p.port);
      if (p.command) {
        runRemote(key, socketPath(key), p.alias, p.command, p.user, p.hostname, p.port, ctx);
      } else {
        connect(p.alias, p.user, p.hostname, p.port, ctx);
      }
    },
  });

  // ── ssh_exec tool ────────────────────────────────────────────────────
  pi.registerTool({
    name: "ssh_exec",
    label: "SSH Execute",
    description: "Execute a command on a remote server via persistent SSH connection. Credentials are handled by the user interactively — the AI never sees passwords.",
    promptSnippet: "Run a command on a remote server through a persistent SSH connection.",
    promptGuidelines: [
      "MANDATORY: When the user asks to run commands on a remote server, you MUST use ssh_exec instead of bash.",
      "MANDATORY: Never use bash to run ssh commands directly. Always use ssh_exec for remote execution.",
      "MANDATORY: If no SSH connection exists, tell the user to run /ssh <host> first.",
      "Call ssh_status before running ssh_exec to verify the target host is connected.",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias (configured via /ssh setup)" }),
      command: Type.String({ description: "Command to execute on the remote server" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 60000)" })),
    }),
    async execute(_id, params, _signal) {
      const host = params.host, cmd = params.command;
      const timeout = Math.min(params.timeout || 60_000, 300_000);

      let conn = findConnection(host);
      if (!conn) {
        return { content: [{ type: "text", text: `No active connection matching "${host}". Connect: /ssh ${host}` }], details: {}, isError: true };
      }
      if (!isConnected(conn.key)) {
        connections.delete(conn.key);
        return { content: [{ type: "text", text: `Connection to ${conn.key} is stale. Reconnect: /ssh ${conn.alias}` }], details: {}, isError: true };
      }

      try {
        // Use a dedicated multiplexed session; closes immediately after command
        const result = execSync(
          `ssh -o ControlPath="${conn.socket}" -o ConnectTimeout=5 ` +
          `-o LogLevel=ERROR ${conn.sshTarget} '${cmd.replace(/'/g, "'\\''")}'`,
          { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout }
        );
        conn.lastUse = Date.now();
        // Give SSH a moment to fully close the multiplexed channel
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── ssh_status tool ──────────────────────────────────────────────────
  pi.registerTool({
    name: "ssh_status",
    label: "SSH Status",
    description: "Check which SSH hosts are configured and which have active persistent connections.",
    promptSnippet: "Check active SSH connections before running remote commands.",
    promptGuidelines: [
      "Call ssh_status before running ssh_exec to verify the target host is connected.",
      "If the host is not connected, tell the user: /ssh <host>",
    ],
    parameters: Type.Object({}),
    async execute() {
      syncFromDisk();
      if (connections.size === 0) {
        return { content: [{ type: "text", text: "No active SSH connections. Use /ssh user@host to connect." }], details: {} };
      }
      const lines = ["Active SSH connections:"];
      for (const [, c] of connections) {
        const active = isConnected(c.key);
        const elapsed = ((Date.now() - c.startTime) / 60000).toFixed(0);
        lines.push(`  ${active ? "🟢" : "⚫"} ${c.key} (${elapsed} min)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.on("session_shutdown", () => { /* keep connections alive */ });
}

// ── UI helpers ──────────────────────────────────────────────────────────────

function showStatus(ctx: any): void {
  syncFromDisk();
  if (connections.size === 0) { ctx.ui.notify("No active connections.", "info"); return; }
  const lines = ["SSH Connections:"];
  for (const [, c] of connections) {
    const active = isConnected(c.key);
    lines.push(`  ${active ? "🟢" : "⚫"} ${c.key} (${((Date.now() - c.startTime) / 60000).toFixed(0)} min)`);
  }
  ctx.ui.setWidget("ssh-status", lines.map((l) => `│ ${l}`));
}

function closeConn(target: string, ctx: any): void {
  for (const [key, c] of connections) {
    if (c.key.includes(target) || c.alias.includes(target)) {
      const r = sh(`ssh -O exit -o ControlPath="${c.socket}" x 2>/dev/null`);
      try { rmSync(c.socket); } catch { /* ok */ }
      connections.delete(key);
      ctx.ui.notify(`Closed ${c.key}.`, "info");
      return;
    }
  }
  ctx.ui.notify(`No connection matching "${target}".`, "error");
}
