/**
 * SSH extension — persistent multiplexed connections, standard SSH syntax.
 *
 * Security:
 *   - Passwords are collected via pi TUI overlay — the AI NEVER sees credentials.
 *   - ControlMaster multiplexes sessions: one authentication → many commands.
 *
 * Usage (same as standard ssh):
 *   /ssh root@host                        connect to host:22
 *   /ssh -p 50159 root@host               connect to host:50159
 *   /ssh root@host "ls /data"             run command via persistent connection
 *   /ssh status                           show active connections
 *   /ssh close root@host                  close connection to host
 *
 * No ~/.ssh/config modifications. All connection state in memory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── connection state (in-memory only, no config file) ──────────────────────

const SOCKET_DIR = join(homedir(), ".ssh", "pi-sockets");

interface Connection {
  host: string;       // "root@host:port"
  socket: string;     // path to ControlMaster socket
  startTime: number;
  lastUse: number;
}

const connections = new Map<string, Connection>();

function connKey(user: string, hostname: string, port: number): string {
  return `${user}@${hostname}:${port}`;
}

function getSocket(key: string): string {
  return join(SOCKET_DIR, `${key.replace(/[@:]/g, "_")}.sock`);
}

function isConnected(key: string): boolean {
  const socket = getSocket(key);
  if (!existsSync(socket)) return false;
  try {
    execSync(`ssh -O check -o ControlPath="${socket}" dummy 2>&1`, {
      encoding: "utf-8", stdio: "pipe", timeout: 5_000,
    });
    return true;
  } catch (e: any) {
    return e.stdout?.includes("Master running") || e.stderr?.includes("Master running") || false;
  }
}

// ── parse SSH args + resolve via ssh config ────────────────────────────────

interface SshTarget {
  alias: string;       // Original input (can be host alias from config)
  user: string;
  hostname: string;    // Resolved hostname (from config or input)
  port: number;
  command: string;
}

/** Resolve host config via ssh -G. Returns null if no match. */
function resolveSshConfig(host: string): { user: string; hostname: string; port: number } | null {
  try {
    const out = execSync(`ssh -G "${host}"`, {
      encoding: "utf-8", stdio: "pipe", timeout: 5_000,
    });
    const config: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const idx = line.indexOf(" ");
      if (idx > 0) config[line.substring(0, idx)] = line.substring(idx + 1);
    }
    // Only return if ssh -G resolved to a DIFFERENT hostname (config entry exists)
    if (config["hostname"] && config["hostname"] !== host) {
      return {
        user: config["user"] || "root",
        hostname: config["hostname"],
        port: parseInt(config["port"] || "22", 10),
      };
    }
    // Check if port was overridden
    if (config["port"] && config["port"] !== "22") {
      return {
        user: config["user"] || "root",
        hostname: host,
        port: parseInt(config["port"], 10),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function parseSshArgs(args: string): SshTarget | null {
  const parts = args.trim().split(/\s+/);
  let user = "";
  let hostname = "";
  let port = 0;
  let command = "";
  let i = 0;

  while (i < parts.length) {
    const p = parts[i];
    if (p === "-p" && i + 1 < parts.length) {
      port = parseInt(parts[i + 1], 10);
      i += 2;
    } else if (p.startsWith("-")) {
      if (i + 1 < parts.length && !parts[i + 1].startsWith("-")) i += 2;
      else i += 1;
    } else if (p.includes("@")) {
      const [u, h] = p.split("@");
      user = u;
      if (h.includes(":")) {
        const [hn, pt] = h.split(":");
        hostname = hn;
        port = port || parseInt(pt, 10);
      } else {
        hostname = h;
      }
      if (i + 1 < parts.length) {
        command = parts.slice(i + 1).join(" ");
      }
      i = parts.length;
    } else {
      hostname = p;
      if (i + 1 < parts.length) {
        command = parts.slice(i + 1).join(" ");
      }
      i = parts.length;
    }
  }

  if (!hostname) return null;

  // Save original alias BEFORE resolving config
  const alias = hostname;

  // Resolve via SSH config
  const resolved = resolveSshConfig(hostname);
  if (resolved) {
    if (!user) user = resolved.user;
    hostname = resolved.hostname;
    if (!port) port = resolved.port;
  }

  return {
    alias,  // Original alias for SSH Host pattern matching
    user: user || "root",
    hostname: resolved?.hostname || hostname,
    port: port || 22,
    command,
  };
}

// ── sh helper ───────────────────────────────────────────────────────────────

function sh(cmd: string, timeout = 30_000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    return e.stderr || e.message || "";
  }
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Ensure socket directory exists
  if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });

  // ── tool_call interceptor: BLOCK any form of remote access ──────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const cmd = ((event.input as any)?.command || "") as string;

      // Block sshpass (always used to bypass SSH auth)
      if (/\bsshpass\b/.test(cmd)) {
        return {
          block: true,
          reason:
            "sshpass is blocked. Use ssh_exec(host, command) instead. " +
            "It provides persistent connections without needing sshpass. " +
            "First ensure the user has connected: /ssh <host>",
        };
      }

      // Block ssh/scp/sftp/rsync targeting remote hosts
      // Matches: ssh, scp, sftp, rsync with user@host or -p port patterns
      const remotePatterns = [
        /\bssh\s+(?:-[a-zA-Z]*\S*\s+)*\S*@\S+/,           // ssh user@host
        /\bssh\s+(?:-[a-zA-Z]*\S*\s+)*\S+\s+[\"']?ssh\b/, // ssh host "ssh ..." (nested)
        /\bscp\s+(?:-[a-zA-Z]*\S*\s+)*\S*@\S+/,           // scp user@host
        /\bsftp\s+(?:-[a-zA-Z]*\S*\s+)*\S+@\S+/,          // sftp user@host
        /\brsync\s+.*[\s:]\S+@\S+:/,                       // rsync ... user@host:
        /\bssh\b.*\bConnectTimeout\b/,                      // ssh with options (bypass via timeout)
      ];
      for (const pattern of remotePatterns) {
        if (pattern.test(cmd)) {
          return {
            block: true,
            reason:
              "Remote access commands (ssh/scp/sftp/rsync) are blocked. " +
              "Use ssh_exec(host, command) for remote execution. " +
              "If no connection exists, the user must run /ssh <host> first.",
          };
        }
      }
    }
  });

  // ── /ssh command ─────────────────────────────────────────────────────
  pi.registerCommand("ssh", {
    description:
      "SSH with persistent connections. Same syntax as standard ssh. " +
      "/ssh -p PORT user@host [command]",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /ssh [-p PORT] user@host [command]  |  /ssh status  |  /ssh close user@host", "warning");
        return;
      }

      // Special subcommands
      if (args.trim() === "status" || args.trim().startsWith("status ")) {
        showStatus(ctx);
        return;
      }
      if (args.trim().startsWith("close ")) {
        const target = args.trim().slice(6).trim();
        closeConnection(target, ctx);
        return;
      }

      const parsed = parseSshArgs(args);
      if (!parsed) {
        ctx.ui.notify("Invalid SSH syntax. Usage: /ssh [-p PORT] user@host [command]", "error");
        return;
      }

      const { alias, user, hostname, port, command } = parsed;
      const key = connKey(user, hostname, port);
      const socket = getSocket(key);

      if (command) {
        // Execute command on remote
        await runRemoteCommand(key, socket, command, alias, user, hostname, port, ctx);
      } else {
        // Connect (open persistent connection)
        await connectToHost(key, socket, alias, user, hostname, port, ctx, pi);
      }
    },
  });

  // ── ssh_exec tool (AI can use) ──────────────────────────────────────
  pi.registerTool({
    name: "ssh_exec",
    label: "SSH Execute",
    description:
      "Execute a command on a remote server via persistent SSH connection. " +
      "The user must have connected first via /ssh user@host. " +
      "Credentials are handled by the user interactively — the AI never sees passwords.",
    promptSnippet: "Run a command on a remote server through a persistent SSH connection.",
    promptGuidelines: [
      "MANDATORY: When the user asks you to run commands on a remote server, you MUST use ssh_exec instead of bash.",
      "MANDATORY: Never use bash to run ssh commands directly (e.g., 'ssh user@host cmd'). Always use ssh_exec for remote execution.",
      "MANDATORY: If no SSH connection exists, tell the user to run /ssh <host> first to open a persistent connection.",
      "Use ssh_status to check which hosts are currently connected before running remote commands.",
      "The SSH connection persists across pi sessions — if the user connected earlier, the connection is likely still active.",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias (configured via /ssh setup)" }),
      command: Type.String({ description: "Command to execute on the remote server" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 60000)" })),
    }),
    async execute(_id, params, _signal) {
      const host = params.host;
      const cmd = params.command;
      const timeout = Math.min(params.timeout || 60_000, 300_000);

      // Flexible matching: find connection by any recognizable part
      let found: Connection | undefined;
      for (const [key, conn] of connections) {
        // Extract components from stored key (user@hostname:port)
        const [userHost, portStr] = conn.host.split(":");
        const [user, connHost] = userHost.includes("@")
          ? userHost.split("@")
          : ["", userHost];

        const search = host.toLowerCase();
        if (
          conn.host === search ||
          key === search ||
          conn.host.toLowerCase().includes(search) ||
          connHost.toLowerCase().includes(search) ||
          (user && user.toLowerCase().includes(search))
        ) {
          found = conn;
          break;
        }
      }

      // If not found by substring, try matching by socket existence
      if (!found) {
        for (const [key, conn] of connections) {
          if (existsSync(conn.socket) && isConnected(key)) {
            found = conn;
            break;
          }
        }
      }

      if (!found) {
        // List available connections in error
        const available = [...connections.keys()].join(", ") || "none";
        return {
          content: [{
            type: "text",
            text: `No active SSH connection matching "${host}".\n` +
              `Available connections: ${available}\n` +
              `Connect first: /ssh <host>`,
          }],
          details: {},
          isError: true,
        };
      }

      if (!isConnected(found.host)) {
        connections.delete(found.host);
        return {
          content: [{
            type: "text",
            text: `Connection to ${found.host} is stale. Reconnect with: /ssh ${found.host}`,
          }],
          details: {},
          isError: true,
        };
      }

      try {
        const [userHost] = found.host.split(":");
        const result = execSync(
          `ssh -o ControlPath="${found.socket}" -o ConnectTimeout=5 "${userHost}" '${cmd.replace(/'/g, "'\\''")}'`,
          { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout }
        );
        found.lastUse = Date.now();
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
      if (connections.size === 0) {
        return {
          content: [{ type: "text", text: "No SSH connections. Use /ssh user@host to connect." }],
          details: {},
        };
      }
      const lines = ["Active SSH connections:"];
      for (const [key, c] of connections) {
        const active = isConnected(key);
        const elapsed = ((Date.now() - c.startTime) / 60000).toFixed(0);
        lines.push(`  ${active ? "🟢" : "⚫"} ${c.host} (${elapsed} min)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── session_shutdown (keep connections alive across sessions) ────────
  pi.on("session_shutdown", () => {
    // Don't close connections — they persist across pi sessions
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function connectToHost(
  key: string, socket: string,
  alias: string, user: string, hostname: string, port: number,
  ctx: any, pi: ExtensionAPI
): Promise<void> {
  if (isConnected(key)) {
    ctx.ui.notify(`Already connected to ${user}@${hostname}:${port}.`, "info");
    return;
  }

  // Open SSH in a separate terminal window so the user can enter
  // password or private-key passphrase natively.
  ctx.ui.notify(
    `Opening SSH to ${user}@${hostname}:${port} in new terminal...`,
    "info"
  );

  // Build the SSH command — use alias so SSH resolves config (Host pattern matching)
  const sshTarget = (alias !== hostname) ? alias : `${user}@${hostname}`;
  const sshArgs = [
    "-e", "bash", "-c",
    [
      "echo", `"Connecting to ${user}@${hostname}:${port}..."`,
      "&&",
      "ssh",
      "-o", `ControlPath=${socket}`,
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=2h",
      "-o", "ServerAliveInterval=60",
      "-o", "ServerAliveCountMax=5",
      "-o", "StrictHostKeyChecking=accept-new",
      "-f", "-N",
      sshTarget,
      "&&",
      "echo", `"Connected! You may close this window."`,
      "||",
      "echo", `"Authentication failed. Check credentials and try again."`,
      ";",
      "read -p 'Press Enter to close...'",
    ].join(" "),
  ];

  // Spawn in a new alacritty window
  const proc = spawn("alacritty", sshArgs, {
    stdio: "ignore",
    detached: true,
    cwd: ctx.cwd,
  });
  proc.unref();

  // Non-blocking: poll in background, update status line
  ctx.ui.setStatus("ssh-" + key, `Waiting for ${user}@${hostname}...`);

  let attempts = 0;
  const maxAttempts = 10; // 20s total
  const check = () => {
    attempts++;
    if (isConnected(key)) {
      connections.set(key, { host: key, socket, startTime: Date.now(), lastUse: Date.now() });
      ctx.ui.setStatus("ssh-" + key, "");
      ctx.ui.notify(`Connected to ${user}@${hostname}:${port}.`, "info");
      return;
    }
    if (attempts < maxAttempts) {
      ctx.ui.setStatus("ssh-" + key, `Waiting for ${user}@${hostname}... (${attempts * 2}s)`);
      setTimeout(check, 2000);
    } else {
      ctx.ui.setStatus("ssh-" + key, "");
      ctx.ui.notify(`Timeout waiting for ${user}@${hostname}. Run /ssh status to check.`, "warning");
    }
  };
  setTimeout(check, 2000);
}

async function runRemoteCommand(
  key: string, socket: string, command: string,
  alias: string, user: string, hostname: string, port: number,
  ctx: any
): Promise<void> {
  if (!isConnected(key)) {
    ctx.ui.notify(`No connection to ${user}@${hostname}:${port}. Connect first: /ssh ${user}@${hostname}`, "warning");
    return;
  }

  ctx.ui.setStatus("ssh-" + key, `running on ${user}@${hostname}...`);

  const result = sh(
    `ssh -o ControlPath="${socket}" -o ConnectTimeout=5 "${alias}" '${command.replace(/'/g, "'\\''")}'`,
    120_000
  );

  ctx.ui.setStatus("ssh-" + key, "");

  connections.get(key)!.lastUse = Date.now();

  ctx.ui.setWidget("ssh-result", [
    `┌─ ${user}@${hostname}:${port} ─────────────────────`,
    `│ ${command.substring(0, 60)}`,
    `├──────────────────────────────────────────`,
    ...result.split("\n").slice(0, 40).map((l: string) => `│ ${l.substring(0, 80)}`),
    result.split("\n").length > 40 ? `│ ... (${result.split("\n").length - 40} more lines)` : "",
    `└──────────────────────────────────────────`,
  ].filter(Boolean));
}

function showStatus(ctx: any): void {
  if (connections.size === 0) {
    ctx.ui.notify("No active SSH connections.", "info");
    return;
  }

  const lines = ["SSH Connections:"];
  for (const [key, c] of connections) {
    const active = isConnected(key);
    const elapsed = ((Date.now() - c.startTime) / 60000).toFixed(0);
    lines.push(`  ${active ? "🟢" : "⚫"} ${c.host} (${elapsed} min)`);
  }
  lines.push("");
  lines.push("Close: /ssh close <user@host>");

  ctx.ui.setWidget("ssh-status", lines.map((l) => `│ ${l}`));
}

function closeConnection(target: string, ctx: any): void {
  // Find matching connection
  let found: string | undefined;
  for (const [key, conn] of connections) {
    if (conn.host.includes(target) || key.includes(target) || conn.host === target) {
      found = key;
      break;
    }
  }

  if (!found) {
    ctx.ui.notify(`No connection matching "${target}". /ssh status to see active connections.`, "error");
    return;
  }

  const conn = connections.get(found)!;
  sh(`ssh -O exit -o ControlPath="${conn.socket}" dummy 2>/dev/null`);
  try { rmSync(conn.socket); } catch { /* ok */ }
  connections.delete(found);
  ctx.ui.notify(`Closed connection to ${conn.host}.`, "info");
}
