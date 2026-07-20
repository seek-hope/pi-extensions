/**
 * SSH extension — persistent multiplexed connections for remote server operations.
 *
 * Security:
 *   - Passwords/private-key passphrases are entered interactively by the user
 *     via a terminal prompt — the AI NEVER sees credentials.
 *   - SSH ControlMaster multiplexes sessions: one authentication → many commands.
 *
 * Efficiency:
 *   - ControlPersist keeps the connection alive for 1 hour.
 *   - All commands reuse the same TCP connection (no repeated handshakes).
 *
 * Commands:
 *   /ssh setup <host> <hostname> [user]  — configure a persistent host
 *   /ssh connect <host>                  — open persistent connection
 *   /ssh <host> <command>                — run command via persistent connection
 *   /ssh status                          — show active connections
 *   /ssh close <host>                    — close persistent connection
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── config ──────────────────────────────────────────────────────────────────

const SSH_DIR = join(homedir(), ".ssh");
const SOCKET_DIR = join(SSH_DIR, "sockets");
const CONFIG_FILE = join(SSH_DIR, "config");
const PI_MARKER = "# [pi-ssh-managed]";

// Ensure socket directory exists
if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });

// ── helpers ─────────────────────────────────────────────────────────────────

function sh(cmd: string, timeout = 30_000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    return e.stderr || e.message || "";
  }
}

interface SshHost {
  alias: string;
  hostname: string;
  user: string;
}

function parseSshConfig(): SshHost[] {
  const hosts: SshHost[] = [];
  if (!existsSync(CONFIG_FILE)) return hosts;

  const content = readFileSync(CONFIG_FILE, "utf-8");
  const lines = content.split("\n");
  let current: Partial<SshHost> = {};
  let inPiBlock = false;

  for (const line of lines) {
    if (line.trim() === PI_MARKER) {
      inPiBlock = true;
      continue;
    }
    if (inPiBlock && line.trim().startsWith("Host ") && current.alias) {
      if (current.hostname && current.user) {
        hosts.push(current as SshHost);
      }
      current = {};
    }
    if (inPiBlock) {
      const hostMatch = line.trim().match(/^Host\s+(.+)/);
      if (hostMatch) {
        if (current.alias && current.hostname) {
          hosts.push(current as SshHost);
        }
        current = { alias: hostMatch[1] };
      }
      const hnMatch = line.trim().match(/^\s*HostName\s+(.+)/);
      if (hnMatch) current.hostname = hnMatch[1];
      const userMatch = line.trim().match(/^\s*User\s+(.+)/);
      if (userMatch) current.user = userMatch[1];
    }
  }
  if (current.alias && current.hostname && current.user) {
    hosts.push(current as SshHost);
  }
  return hosts;
}

function hasActiveConnection(host: string): boolean {
  const socket = join(SOCKET_DIR, `${host}.sock`);
  if (!existsSync(socket)) return false;
  const out = sh(`ssh -O check -o ControlPath="${socket}" "${host}" 2>&1`);
  return out.includes("Master running");
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /ssh command ──────────────────────────────────────────────────────
  pi.registerCommand("ssh", {
    description: "Manage persistent SSH connections. /ssh <host> <cmd> to run remotely.",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0];
      const rest = parts.slice(1);

      switch (subcmd) {
        case "setup": {
          if (rest.length < 2) {
            ctx.ui.notify("Usage: /ssh setup <alias> <hostname> [user]", "warning");
            return;
          }
          const alias = rest[0];
          const hostname = rest[1];
          const user = rest[2] || "root";

          // Add to ~/.ssh/config with ControlMaster
          const block = [
            PI_MARKER,
            `Host ${alias}`,
            `    HostName ${hostname}`,
            `    User ${user}`,
            `    ControlMaster auto`,
            `    ControlPath ${SOCKET_DIR}/${alias}.sock`,
            `    ControlPersist 2h`,
            `    ServerAliveInterval 60`,
            `    ServerAliveCountMax 5`,
            "",
          ].join("\n");

          // Check if already configured
          const existing = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf-8") : "";
          if (existing.includes(`Host ${alias}`) && existing.includes(PI_MARKER)) {
            ctx.ui.notify(`Host ${alias} already configured. Use /ssh connect ${alias}.`, "info");
            return;
          }

          appendFileSync(CONFIG_FILE, "\n" + block);
          ctx.ui.notify(`Host ${alias} configured (${user}@${hostname}). /ssh connect ${alias} to open connection.`, "info");
          return;
        }

        case "connect": {
          if (rest.length < 1) {
            ctx.ui.notify("Usage: /ssh connect <alias>", "warning");
            return;
          }
          const host = rest[0];
          const hosts = parseSshConfig();
          const cfg = hosts.find((h) => h.alias === host);

          if (!cfg) {
            ctx.ui.notify(`Host ${host} not configured. Use /ssh setup ${host} <hostname> [user] first.`, "error");
            return;
          }

          if (hasActiveConnection(host)) {
            ctx.ui.notify(`Already connected to ${host}.`, "info");
            return;
          }

          ctx.ui.notify(`Connecting to ${host} (${cfg.user}@${cfg.hostname})...`, "info");
          ctx.ui.notify(`A tmux window will open. Enter your password, then detach with Ctrl+B D.`, "info");

          // Use tmux for interactive password entry — pi's TUI can't share the terminal directly
          const socket = join(SOCKET_DIR, `${host}.sock`);
          const tmuxSession = `ssh-connect-${host}`;

          // Kill any existing connect session
          sh(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`);

          // Start SSH in a named tmux session. The user will see the password prompt.
          const proc = spawn("tmux", [
            "new-session", "-s", tmuxSession,
            "ssh",
            "-o", `ControlPath=${socket}`,
            "-o", "StrictHostKeyChecking=accept-new",
            "-N",
            host,
          ], {
            stdio: "inherit",
            cwd: ctx.cwd,
          });

          await new Promise<void>((resolve) => {
            proc.on("exit", (code) => {
              // Clean up the tmux session
              sh(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`);

              if (code === 0 || hasActiveConnection(host)) {
                ctx.ui.notify(`Connected to ${host}. Persistent session active (2h idle timeout).`, "info");
              } else {
                ctx.ui.notify(`Connection to ${host} failed (exit ${code}). Check password and try again.`, "error");
              }
              resolve();
            });
          });
          return;
        }

        case "status": {
          const hosts = parseSshConfig();
          if (hosts.length === 0) {
            ctx.ui.notify("No SSH hosts configured. Use /ssh setup <alias> <hostname> [user].", "info");
            return;
          }

          const lines = ["SSH Connections:"];
          for (const h of hosts) {
            const active = hasActiveConnection(h.alias);
            lines.push(`  ${active ? "🟢" : "⚫"} ${h.alias}: ${h.user}@${h.hostname} ${active ? "(connected)" : ""}`);
          }

          // Also list active tmux SSH sessions
          const tmuxSessions = sh("tmux list-sessions 2>/dev/null | grep pi-bg || true");
          if (tmuxSessions) {
            lines.push("");
            lines.push("Background tasks (tmux):");
            for (const l of tmuxSessions.split("\n")) {
              if (l.trim()) lines.push(`  ${l}`);
            }
          }

          ctx.ui.setWidget("ssh-status", lines.map((l) => `│ ${l}`));
          return;
        }

        case "close": {
          if (rest.length < 1) {
            ctx.ui.notify("Usage: /ssh close <alias>", "warning");
            return;
          }
          const host = rest[0];
          if (!hasActiveConnection(host)) {
            ctx.ui.notify(`No active connection to ${host}.`, "info");
            return;
          }

          sh(`ssh -O exit -o ControlPath="${SOCKET_DIR}/${host}.sock" "${host}" 2>/dev/null`);
          ctx.ui.notify(`Connection to ${host} closed.`, "info");
          return;
        }

        default: {
          // Treat as: /ssh <host> <command...>
          const host = subcmd;
          const command = rest.join(" ");
          if (!command) {
            ctx.ui.notify("Usage: /ssh <host> <command>", "warning");
            return;
          }

          const hosts = parseSshConfig();
          if (!hosts.find((h) => h.alias === host)) {
            ctx.ui.notify(`Host ${host} not configured. /ssh setup ${host} <hostname> [user]`, "error");
            return;
          }

          if (!hasActiveConnection(host)) {
            ctx.ui.notify(`No active connection to ${host}. Run /ssh connect ${host} first.`, "warning");
            return;
          }

          const result = sh(`ssh -o ControlPath="${SOCKET_DIR}/${host}.sock" "${host}" '${command.replace(/'/g, "'\\''")}'`, 120_000);
          ctx.ui.setWidget("ssh-result-" + host, [
            `┌─ ${host}: ${command.substring(0, 50)} ──────`,
            ...result.split("\n").slice(0, 40).map((l: string) => `│ ${l.substring(0, 80)}`),
            `└─────────────────────────────────────────`,
          ]);
        }
      }
    },
  });

  // ── ssh_exec tool (AI can use) ────────────────────────────────────────
  pi.registerTool({
    name: "ssh_exec",
    label: "SSH Execute",
    description:
      "Execute a command on a remote server via persistent SSH connection. " +
      "The user must have set up the host with /ssh setup and /ssh connect first. " +
      "Credentials are handled by the user interactively — the AI never sees passwords.",
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias (configured via /ssh setup)" }),
      command: Type.String({ description: "Command to execute on the remote server" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 60000)" })),
    }),
    async execute(_id, params, _signal) {
      const host = params.host;
      const cmd = params.command;
      const timeout = Math.min(params.timeout || 60_000, 300_000);

      const socket = join(SOCKET_DIR, `${host}.sock`);
      if (!existsSync(socket)) {
        return {
          content: [{
            type: "text",
            text: `No persistent connection to ${host}. The user needs to run: /ssh connect ${host}`,
          }],
          details: {},
          isError: true,
        };
      }

      try {
        const result = execSync(
          `ssh -o ControlPath="${socket}" -o ConnectTimeout=5 "${host}" '${cmd.replace(/'/g, "'\\''")}'`,
          { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout }
        );
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        // Check if connection died
        if (e.stderr?.includes("Connection refused") || e.stderr?.includes("No such file")) {
          return {
            content: [{
              type: "text",
              text: `SSH connection to ${host} lost. The user needs to run: /ssh connect ${host}\n\nError: ${e.stderr || e.message}`,
            }],
            details: {},
            isError: true,
          };
        }
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  // ── ssh_status tool ──────────────────────────────────────────────────
  pi.registerTool({
    name: "ssh_status",
    label: "SSH Status",
    description: "Check which SSH hosts are configured and which have active persistent connections.",
    parameters: Type.Object({}),
    async execute() {
      const hosts = parseSshConfig();
      if (hosts.length === 0) {
        return {
          content: [{ type: "text", text: "No SSH hosts configured. Use /ssh setup <alias> <hostname> [user]." }],
          details: {},
        };
      }

      const lines = ["SSH Hosts:"];
      for (const h of hosts) {
        const active = hasActiveConnection(h.alias);
        lines.push(`  ${active ? "🟢" : "⚫"} ${h.alias}: ${h.user}@${h.hostname} ${active ? "(connected)" : "(disconnected)"}`);
      }
      lines.push("");
      lines.push("Connect: /ssh connect <alias>");
      lines.push("Execute: /ssh <alias> <command>");
      lines.push("Close:   /ssh close <alias>");

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── session_shutdown cleanup ────────────────────────────────────────
  pi.on("session_shutdown", () => {
    // Don't close SSH connections — they're persistent across sessions
    // ControlPersist 1h handles idle timeout
  });
}
