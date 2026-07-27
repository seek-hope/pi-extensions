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
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const SOCKET_DIR = join(homedir(), ".ssh", "pi-sockets");
const REMOTE_TASKS_FILE = join(SOCKET_DIR, "remote-tasks.json");

interface PendingEntry {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  rand: string;
  timer: ReturnType<typeof setTimeout> | null;
  onProcExit: (code: number | null) => void;
  onStdinError: (err: Error) => void;
  onDrain: (() => void) | undefined;
  bufAtWrite: string;
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
}
const remoteTasks: RemoteBgTask[] = [];
const spawningRemoteBg = new Set<string>(); // guards ssh_exec bg dedup against TOCTOU races

function saveRemoteTasks(): void {
  try {
    mkdirSync(SOCKET_DIR, { recursive: true });
    writeFileSync(REMOTE_TASKS_FILE, JSON.stringify(remoteTasks, null, 2));
  } catch { /* best effort */ }
}

function loadRemoteTasks(): void {
  try {
    if (existsSync(REMOTE_TASKS_FILE)) {
      const data = readFileSync(REMOTE_TASKS_FILE, "utf-8");
      const loaded = JSON.parse(data);
      if (Array.isArray(loaded)) {
        remoteTasks.length = 0;
        for (const t of loaded) {
          remoteTasks.push(t);
        }
      }
    }
  } catch { /* best effort */ }
}

const pollRemoteActive = new Set<string>();

// Poll remote background task and inject result when done
function pollRemoteTask(logPath: string, cmd: string, host: string, pid: string | null): void {
  // Prevent duplicate poll loops for the same task
  if (pollRemoteActive.has(logPath)) return; // already polling
  pollRemoteActive.add(logPath);
  const existing = remoteTasks.find(t => t.logPath === logPath);
  if (!existing) {
    remoteTasks.push({ host, logPath, cmd, pid, startTime: Date.now() });
    saveRemoteTasks();
  }

  let lastSize = 0;
  let unchanged = 0;
  let errors = 0;
  const MAX_ERRORS = 5; // ~25s of failures before giving up
  let stopped = false;
  const MAX_POLLS = 720; // 720 * 5s ≈ 60 min max polling duration per task
  let pollCount = 0;

  function cleanup() {
    if (!stopped) {
      stopped = true;
      try { _sshPi?.ui?.setStatus?.("ssh-bg", ""); } catch { /* ok */ }
    }
    const idx = remoteTasks.findIndex(t => t.logPath === logPath);
    if (idx >= 0) { remoteTasks.splice(idx, 1); saveRemoteTasks(); }
    pollRemoteActive.delete(logPath);
  }

  async function check() {
    if (stopped) return;
    // If pollRemoteActive no longer has this logPath, session_shutdown cleared it.
    if (!pollRemoteActive.has(logPath)) { stopped = true; return; }
    pollCount++;
    if (pollCount > MAX_POLLS) {
      // Maximum polling duration reached — force-stop polling and retrieve whatever output exists
      stopped = true;
      try { _sshPi?.ui?.setStatus?.("ssh-bg", ""); } catch { /* ok */ }
      const conn4 = await findConnection(host);
      const doCleanup = () => {
        pollRemoteActive.delete(logPath);
        const idx = remoteTasks.findIndex(t => t.logPath === logPath);
        if (idx >= 0) { remoteTasks.splice(idx, 1); saveRemoteTasks(); }
      };
      if (conn4 && await isConnectedAsync(conn4.key, true)) {
        conn4.lastUse = Date.now();
        shellExec(conn4, `cat '${logPath}' 2>/dev/null || echo '(unavailable)'`, 15_000).then(output => {
          doCleanup();
          if (_sshPi) {
            _sshPi.sendUserMessage([
              { type: "text", text: `[SSH background task on ${host} reached max polling duration (60 min)]` },
              { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
              { type: "text", text: `Output:\n${output.substring(0, 4000)}` },
            ], { deliverAs: "followUp" });
          }
        }).catch(() => {
          doCleanup();
          if (_sshPi) {
            _sshPi.sendUserMessage([
              { type: "text", text: `[SSH background task on ${host} reached max polling duration (60 min)]` },
              { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
              { type: "text", text: `Log on remote: ${logPath}` },
            ], { deliverAs: "followUp" });
          }
        });
      } else if (_sshPi) {
        doCleanup();
        _sshPi.sendUserMessage([
          { type: "text", text: `[SSH background task on ${host} reached max polling duration (60 min), connection lost]` },
          { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
          { type: "text", text: `Log on remote: ${logPath}` },
        ], { deliverAs: "followUp" });
      } else {
        doCleanup();
      }
      return;
    }
    // Verify connection still alive before polling
    const conn2 = await findConnection(host);
    if (!conn2 || !(await isConnectedAsync(conn2.key, true))) {
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
    conn2.lastUse = Date.now();
    shellExec(conn2, `wc -c < '${logPath}' 2>/dev/null || echo 0`, 10_000).then(result => {
      if (stopped) return;
      const size = parseInt(result.trim(), 10) || 0;
      if (size === lastSize) {
        unchanged++;
        // After 5 iterations (25s) of stable file size, verify the process is truly done
        if (unchanged >= 5) {
          // Check if the background PID (if known) is still alive
          const pidCheck = pid ? `kill -0 ${pid} 2>/dev/null && echo alive || echo dead` : "echo unknown";
          conn2.lastUse = Date.now();
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
              return declareDone(conn2);
            }
          }).catch(() => {
            // PID check failed — assume done since size is stable
            return declareDone(conn2);
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
      else {
        if (!stopped) {
          stopped = true;
          try {
            if (_sshPi) {
              _sshPi.sendUserMessage([
                { type: "text", text: `[SSH background task polling failed on ${host}]` },
                { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
                { type: "text", text: `Log on remote: ${logPath}` },
              ], { deliverAs: "followUp" });
            }
          } catch { /* ok */ }
        }
        cleanup();
      }
    });
  }

  async function declareDone(c: Connection) {
    if (stopped) return;
    stopped = true;
    try { _sshPi?.ui?.setStatus?.("ssh-bg", ""); } catch { /* ok */ }
    pollRemoteActive.delete(logPath);
    const idx = remoteTasks.findIndex(t => t.logPath === logPath);
    if (idx >= 0) { remoteTasks.splice(idx, 1); saveRemoteTasks(); }
    // Re-verify connection before fetching the log
    if (!c || !(await isConnectedAsync(c.key))) {
      if (_sshPi) {
        _sshPi.sendUserMessage([
          { type: "text", text: `[SSH background task completed on ${host} but connection lost]` },
          { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
          { type: "text", text: `Log on remote: ${logPath}` },
        ], { deliverAs: "followUp" });
      }
      return;
    }
    c.lastUse = Date.now();
    shellExec(c, `cat '${logPath}' 2>/dev/null`, 15_000).then(output => {
      if (_sshPi) {
        _sshPi.sendUserMessage([
          { type: "text", text: `[SSH background task completed on ${host}]` },
          { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
          { type: "text", text: `Output:\n${output.substring(0, 4000)}` },
        ], { deliverAs: "followUp" });
      }
    }).catch(() => {
      // cat failed — notify user with log path so they can try manually
      try {
        if (_sshPi) {
          _sshPi.sendUserMessage([
            { type: "text", text: `[SSH background task completed on ${host} but output could not be retrieved]` },
            { type: "text", text: `Command: ${cmd.substring(0, 200)}` },
            { type: "text", text: `The cat command failed when trying to read the log. Log on remote: ${logPath}` },
            { type: "text", text: `Try manually: ssh_exec("${host}", "cat '${logPath}'")` },
          ], { deliverAs: "followUp" });
        }
      } catch { /* best effort */ }
    });
  }

  setTimeout(check, 3000);
}

/** Escape a value for safe interpolation inside a double-quoted shell string. */
function shellEscapeDQ(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
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
    if (cfg["hostname"]) {
      return { user: cfg["user"] || "root", hostname: cfg["hostname"], port: parseInt(cfg["port"] || "22", 10) };
    }
    return null;
  } catch { return null; }
}

function parseArgs(args: string): { alias: string; user: string; hostname: string; port: number; command: string } | null {
  // SSH options that take a value — everything else is boolean (no value consumed)
  const VALUE_FLAGS = new Set(["p", "i", "o", "l", "b", "c", "E", "F", "I", "J", "m", "Q", "w", "e", "O", "S", "D", "R", "L"]);
  const parts = args.trim().split(/\s+/);
  let user = "", hostname = "", port = 0, command = "", i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p === "-p") {
      if (i + 1 < parts.length) { const v = parseInt(parts[i + 1]); if (!isNaN(v)) { port = v; i += 2; } else { return null; } }
      else { return null; } // -p without port value: invalid
    }
    else if (p.startsWith("-")) {
      // Handle no-space syntax: -p22, -i~/.ssh/id_rsa, -oStrictHostKeyChecking=no
      const flag = p.replace(/^-+/, "");
      if (flag.length > 1 && VALUE_FLAGS.has(flag[0])) {
        const value = flag.substring(1);
        if (flag[0] === "p") { const v = parseInt(value); if (!isNaN(v)) port = v; }
        else if (flag[0] === "l" && !user) { user = value; }
        i += 1;
      }
      else if (VALUE_FLAGS.has(flag) && i + 1 < parts.length && !parts[i + 1].startsWith("-")) {
        const value = parts[i + 1];
        if (flag === "p") { const v = parseInt(value); if (!isNaN(v)) port = v; }
        else if (flag === "l" && !user) { user = value; }
        i += 2;
      }
      else { i += 1; }
    }
    else if (p.includes("@")) {
      // Split on the LAST @ for user/host boundary (user may contain @ in rare cases)
      const atIdx = p.lastIndexOf("@");
      user = p.substring(0, atIdx);
      const hostPart = p.substring(atIdx + 1);
      if (hostPart.includes(":")) {
        // Handle bracketed IPv6: [::1]:22 or [::1]
        if (hostPart.startsWith("[")) {
          const closeBracket = hostPart.indexOf("]");
          if (closeBracket > 0) {
            hostname = hostPart.substring(0, closeBracket + 1);
            const afterBracket = hostPart.substring(closeBracket + 1);
            if (afterBracket.startsWith(":")) {
              const pt = parseInt(afterBracket.substring(1));
              if (!isNaN(pt)) port = port || pt;
            }
          } else {
            hostname = hostPart; // malformed bracket — treat as literal hostname
          }
        } else {
          const colonIdx = hostPart.lastIndexOf(":");
          hostname = hostPart.substring(0, colonIdx);
          const pt = parseInt(hostPart.substring(colonIdx + 1));
          if (!isNaN(pt)) port = port || pt;
          else hostname = hostPart; // colon but no valid port — treat as hostname
        }
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
  // Must check both exitCode and signalCode: exitCode is null while running OR when
  // killed by a signal, while signalCode is only set when killed by a signal.
  // Use .destroyed and .writableEnded instead of .writable — .writable is false
  // during backpressure (buffer full, drain pending), which would falsely trigger
  // a shell restart and lose in-flight commands.
  if (conn.proc && conn.proc.exitCode === null && conn.proc.signalCode === null && !conn.proc.killed &&
      conn.proc.stdin && !conn.proc.stdin.destroyed && !conn.proc.stdin.writableEnded) return;

  // Clean up dead/dying proc
  if (conn.proc) {
    // Remove stream-level listeners (data, error) on stdout/stderr — these are
    // separate EventEmitters not covered by proc.removeAllListeners().
    // If left attached, buffered pipe data from the old process can fire 'data'
    // events after replacement, corrupting conn.buf with stale output.
    conn.proc.stdout?.removeAllListeners();
    conn.proc.stderr?.removeAllListeners();
    conn.proc.stdin?.removeAllListeners();
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

  if (conn.proc.stdout) {
    conn.proc.stdout.on("data", (chunk: Buffer) => {
      conn.buf += chunk.toString();
      extractResponses(conn);
    });
  }

  if (conn.proc.stderr) {
    conn.proc.stderr.on("data", (chunk: Buffer) => {
      // Include stderr in output — it may contain error messages
      conn.buf += chunk.toString();
      extractResponses(conn);
    });
  }

  conn.proc.on("exit", (code) => {
    const deadProc = conn.proc;
    conn.proc = null;
    for (const [, p] of conn.pending) {
      if (p.timer) clearTimeout(p.timer);
      // Remove per-command listeners to prevent leaks (ensureShell exit fires before shellExec's once handlers)
      if (deadProc) {
        deadProc.removeListener("exit", p.onProcExit);
        deadProc.stdin?.removeListener("error", p.onStdinError);
        if (p.onDrain) deadProc.stdin?.removeListener("drain", p.onDrain);
      }
      p.reject(new Error(`SSH shell exited (code ${code})`));
    }
    conn.pending.clear();
  });

  conn.proc.on("error", (err) => {
    const deadProc = conn.proc;
    conn.proc = null;
    for (const [, p] of conn.pending) {
      if (p.timer) clearTimeout(p.timer);
      if (deadProc) {
        deadProc.removeListener("exit", p.onProcExit);
        deadProc.stdin?.removeListener("error", p.onStdinError);
        if (p.onDrain) deadProc.stdin?.removeListener("drain", p.onDrain);
      }
      p.reject(new Error(`SSH shell error: ${err.message}`));
    }
    conn.pending.clear();
  });
}

function extractResponses(conn: Connection): void {
  // Safety: if buffer grows too large without a valid marker, truncate from front
  const MAX_BUF = 2 * 1024 * 1024; // 2 MB
  if (conn.buf.length > MAX_BUF) {
    // Find the last VALID marker (matching a real pending entry) to truncate from,
    // rather than using lastIndexOf("__END__") which can match orphan text in command output.
    let truncatePos = -1;
    const markerRegex = /__END__(\d+)_(\w+):(\d+)\n/g;
    let match;
    while ((match = markerRegex.exec(conn.buf)) !== null) {
      const reqId = parseInt(match[1], 10);
      const rand = match[2];
      const p = conn.pending.get(reqId);
      if (p && p.rand === rand) {
        truncatePos = match.index;
      }
    }
    if (truncatePos >= 0) {
      // Discard everything before the last valid marker (stale data)
      conn.buf = conn.buf.substring(truncatePos);
    } else {
      // No marker at all — keep the most recent 1 MB to avoid losing a pending marker.
      // Align truncation to the nearest newline boundary so we never split a
      // partially-received __END__ marker across the discarded/kept boundary.
      const keep = Math.floor(MAX_BUF / 2);
      const discardEnd = conn.buf.length - keep;
      const lastNewline = conn.buf.lastIndexOf('\n', discardEnd);
      const truncateFrom = lastNewline >= 0 ? lastNewline + 1 : discardEnd;
      conn.buf = conn.buf.substring(truncateFrom);
    }
  }
  while (true) {
    const m = conn.buf.match(/__END__(\d+)_(\w+):(\d+)\n/);
    if (!m) break;
    const idx = conn.buf.indexOf(m[0]);
    const reqId = parseInt(m[1]);
    const rand = m[2];
    const p = conn.pending.get(reqId);
    // Validate the random token to prevent marker injection from command output
    if (p && p.rand === rand) {
      // Valid marker — resolve with output before it and truncate buffer.
      // Use bufAtWrite to exclude stale output from orphaned/timed-out commands.
      const startIdx = conn.buf.indexOf(p.bufAtWrite);
      const output = startIdx >= 0
        ? conn.buf.substring(startIdx + p.bufAtWrite.length, idx)
        : conn.buf.substring(0, idx);
      conn.buf = conn.buf.substring(idx + m[0].length);
      conn.pending.delete(reqId);
      if (p.timer) clearTimeout(p.timer);
      // Remove per-command listeners to prevent unbounded accumulation
      if (conn.proc) {
        conn.proc.removeListener("exit", p.onProcExit);
        conn.proc.stdin?.removeListener("error", p.onStdinError);
        if (p.onDrain) conn.proc.stdin?.removeListener("drain", p.onDrain);
      }
      p.resolve(output);
    } else {
      // Rand mismatch or orphaned marker — remove only the marker text itself
      // to avoid discarding legitimate command output that happens to contain
      // a string resembling the end-of-response marker.
      conn.buf = conn.buf.substring(0, idx) + conn.buf.substring(idx + m[0].length);
    }
  }
}

function shellExec(conn: Connection, cmd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    ensureShell(conn);
    // Re-check: the process may have exited between ensureShell and now
    if (!conn.proc || conn.proc.exitCode !== null || conn.proc.signalCode !== null || !conn.proc.stdin || conn.proc.stdin.destroyed || conn.proc.stdin.writableEnded) {
      reject(new Error("SSH shell not available"));
      return;
    }
    const reqId = ++conn.reqId;
    const rand = Math.random().toString(36).slice(2, 10);
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    // Shared cleanup: remove per-command listeners to prevent unbounded accumulation
    const cleanupListeners = () => {
      if (conn.proc) {
        conn.proc.removeListener("exit", onProcExit);
        conn.proc.stdin?.removeListener("error", onStdinError);
        if (onDrain) conn.proc.stdin?.removeListener("drain", onDrain);
      }
    };

    const timer = setTimeout(() => {
      done(() => {
        cleanupListeners();
        if (conn.pending.has(reqId)) {
          const entry = conn.pending.get(reqId)!;
          conn.pending.delete(reqId);
          if (entry.timer) clearTimeout(entry.timer);
          const partial = conn.buf || entry.bufAtWrite;
          entry.reject(new Error(`SSH command timeout after ${timeout / 1000}s. Partial output: ${partial.substring(0, 1000)}`));
        }
      });
    }, timeout);

    // Wire up a one-shot error handler on stdin to catch pipe errors
    const onStdinError = (err: Error) => {
      done(() => {
        clearTimeout(timer);
        cleanupListeners();
        conn.pending.delete(reqId);
        reject(new Error(`SSH stdin error: ${err.message}`));
      });
    };

    // Also handle process exit — covers the race where proc dies between the check above
    // and the listener registration (TOCTOU window)
    const onProcExit = (code: number | null) => {
      done(() => {
        clearTimeout(timer);
        cleanupListeners();
        conn.pending.delete(reqId);
        reject(new Error(`SSH shell exited (code ${code}) unexpectedly`));
        // Remove drain listener to prevent listener leak when process exits
        // before drain fires (backpressure case). Must be guarded by settled.
        if (onDrain) conn.proc?.stdin?.removeListener("drain", onDrain);
      });
    };
    conn.proc.once("exit", onProcExit);
    // Re-check: the process may have exited between the initial alive check
    // above and the listener registration (TOCTOU window). If so, manually
    // invoke the handler so the promise doesn't hang until timeout.
    if (conn.proc.exitCode !== null || conn.proc.signalCode !== null) {
      onProcExit(conn.proc.exitCode);
      return;
    }

    conn.proc.stdin!.once("error", onStdinError);

    const bufAtWrite = conn.buf;
    conn.pending.set(reqId, { resolve, reject, rand, timer, onProcExit, onStdinError, onDrain: undefined, bufAtWrite });

    // Pass command directly via stdin — the shell reads lines and executes them
    // Don't wrap in quotes (that would treat semicolons literally)
    let onDrain: (() => void) | undefined;
    try {
      const wrote = conn.proc.stdin!.write(`${cmd}\necho __END__${reqId}_${rand}:$?\n`);
      onDrain = () => {
        // Data flushed successfully — response will arrive via extractResponses.
        // Listeners remain active; done() prevents double-settle.
      };
      // Store onDrain on the pending entry so extractResponses can clean it up
      if (conn.pending.has(reqId)) conn.pending.get(reqId)!.onDrain = onDrain;
      if (!wrote) {
        // Backpressure: wait for drain, but keep exit/error listeners alive.
        // The done() guard prevents double-settling, and removing listeners
        // early could leave the promise hanging if drain fires but the
        // process then errors/exits before extractResponses finds the marker.
        conn.proc.stdin!.once("drain", onDrain);
      }
      // On successful write (wrote=true or after drain), exit/error listeners
      // remain active so the promise settles even if the process crashes
      // before extractResponses fires. The done() guard prevents double-settle.
    } catch (writeErr: any) {
      done(() => {
        clearTimeout(timer);
        cleanupListeners();
        conn.pending.delete(reqId);
        reject(new Error(`SSH write failed: ${writeErr.message}`));
      });
      if (onDrain) conn.proc?.stdin?.removeListener("drain", onDrain);
    }
  });
}

// ── connection management ───────────────────────────────────────────────────

// Async version of isConnected — does not block the event loop with spawnSync.
// Used by the background task poll loop to avoid blocking other async work.
function spawnAsync(cmd: string, args: string[], options: { timeout: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stdout.on("error", () => {}); // prevent unhandled EPIPE crashes
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.stderr.on("error", () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error("timed out")); }, options.timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function isConnectedAsync(key: string, quick = false): Promise<boolean> {
  let sock = socketPath(key);
  if (!existsSync(sock)) {
    const legacySock = join(SOCKET_DIR, key.replace(/[@:]/g, "_") + ".sock");
    if (existsSync(legacySock)) sock = legacySock;
    else return false;
  }
  const timeout = quick ? 2_000 : 5_000;
  try {
    const result = await spawnAsync("ssh", ["-o", `ControlPath=${sock}`, "-O", "check", "x"], { timeout });
    if (result.status === 0) return true;
    const combined = result.stdout + result.stderr;
    if (/master running/i.test(combined)) return true;
    // Master is definitively dead — clean up stale socket
    try { rmSync(sock); } catch { /* ok */ }
    return false;
  } catch {
    // spawnAsync threw (timeout, ssh not found, etc.) — transient error, don't delete socket
    return false;
  }
}

async function connect(alias: string, user: string, hostname: string, port: number, ctx: any): Promise<void> {
  const key = connKey(user, hostname, port);
  const sock = socketPath(key);
  const sshTarget = targetStr(alias, user, hostname, port);
  // Re-check right before connecting (master may have died since last check)
  const alreadyUp = await isConnectedAsync(key);
  if (alreadyUp) {
    if (!connections.has(key)) addConn(key, alias, sock, sshTarget);
    ctx.ui.notify(`Already connected to ${user}@${hostname}:${port}.`, "info");
    return;
  }
  // Dead socket lingering — clean up
  if (existsSync(sock)) { try { rmSync(sock); } catch { /* ok */ } }
  ctx.ui.notify(`Opening SSH to ${user}@${hostname}:${port}...`, "info");
  const displayHost = alias !== hostname ? `${alias} (${user}@${hostname}:${port})` : `${user}@${hostname}:${port}`;
  // Determine which terminal emulator to use
  const termEnv = process.env.TERMINAL || "";
  const termCandidates = [termEnv, "alacritty", "kitty", "gnome-terminal", "xterm"].filter(Boolean);
  const termEmu = termCandidates.find((t) => {
    const r = spawnSync("which", [t], { stdio: "ignore" });
    return r.status === 0;
  }) || "xterm";
  // Escape values to prevent shell injection via malicious hostnames/usernames.
  // displayHost and sock go inside double-quoted strings; sshTarget is word-split
  // by the shell so each word is single-quoted separately.
  const safeDisplayHost = shellEscapeDQ(displayHost);
  const safeSock = shellEscapeDQ(sock);
  const safeSshTarget = sshTarget.split(' ').map(w => `'${w.replace(/'/g, "'\\''")}'`).join(' ');

  const termProc = spawn(termEmu, [
    ...(termEmu === "gnome-terminal" ? ["--", "bash", "-c"] : ["-e", "bash", "-c"]),
    `echo "Connecting to ${safeDisplayHost}..."; ` +
    `ssh -o ControlPath="${safeSock}" -o ControlMaster=auto -o ControlPersist=12h ` +
    `-o ServerAliveInterval=60 -o ServerAliveCountMax=5 ` +
    `-o StrictHostKeyChecking=accept-new -fN ${safeSshTarget} && ` +
    `echo "Connected!" || echo "Auth failed."; read -p 'Press Enter...'`
  ], { stdio: "ignore", detached: true });
  let connectPolling = true;
  termProc.on("error", () => {
    connectPolling = false;
    ctx.ui.setStatus("ssh-" + key, "");
    ctx.ui.notify(`Failed to open terminal (${termEmu} not found?). Use ssh from an external terminal.`, "warning");
  });
  termProc.unref();
  ctx.ui.setStatus("ssh-" + key, `Waiting...`);
  let tries = 0;
  async function poll() {
    if (!connectPolling) return;
    tries++;
    if (await isConnectedAsync(key)) { connectPolling = false; addConn(key, alias, sock, sshTarget); ctx.ui.setStatus("ssh-" + key, ""); ctx.ui.notify(`Connected.`, "info"); return; }
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

async function syncFromDiskAsync(): Promise<void> {
  if (!existsSync(SOCKET_DIR)) return;
  try {
    const entries = readdirSync(SOCKET_DIR);
    const checks: Promise<void>[] = [];
    for (const name of entries) {
      if (!name.endsWith(".sock")) continue;
      const sock = join(SOCKET_DIR, name);
      checks.push((async () => {
        try {
          const result = await spawnAsync("ssh", ["-O", "check", "-o", `ControlPath=${sock}`, "x"], { timeout: 5000 });
          const combined = result.stdout + result.stderr;
          if (result.status !== 0 && !/master running/i.test(combined)) {
            try { rmSync(sock); } catch { /* ok */ }
            return;
          }
          const key = keyFromFilename(name);
          if (![...connections.values()].some(c => c.socket === sock)) {
            // Use lastIndexOf(":") to handle IPv6 addresses (e.g. user@[::1]:22)
            const lastColon = key.lastIndexOf(":");
            if (lastColon < 0) return; // skip legacy/malformed keys without colon
            const uh = key.substring(0, lastColon);
            const pt = key.substring(lastColon + 1);
            addConn(key, uh, sock, pt && pt !== "22" ? `-p ${pt} ${uh}` : uh);
          }
        } catch (syncErr: any) {
          if (syncErr.code === 'ENOENT' || syncErr.code === 'EACCES') return;
          try { rmSync(sock); } catch { /* ok */ }
        }
      })());
    }
    await Promise.all(checks);
  } catch { /* empty */ }
  // Prune stale in-memory connections
  const pruneChecks: Promise<void>[] = [];
  for (const [key, conn] of connections) {
    pruneChecks.push((async () => {
      const sockExists = existsSync(conn.socket);
      if (!sockExists) {
        if (conn.proc) { try { conn.proc.kill(); } catch { /* ok */ } }
        for (const [, p] of conn.pending) {
          if (p.timer) clearTimeout(p.timer);
          try { p.reject(new Error("Connection pruned (socket missing)")); } catch { /* ok */ }
        }
        conn.pending.clear();
        connections.delete(key);
        return;
      }
      try {
        const result = await spawnAsync("ssh", ["-o", `ControlPath=${conn.socket}`, "-O", "check", "x"], { timeout: 2000 });
        const combined = result.stdout + result.stderr;
        if (result.status !== 0 && !/master running/i.test(combined)) {
          if (conn.proc) { try { conn.proc.kill(); } catch { /* ok */ } }
          for (const [, p] of conn.pending) {
            if (p.timer) clearTimeout(p.timer);
            try { p.reject(new Error("Connection pruned (master dead)")); } catch { /* ok */ }
          }
          conn.pending.clear();
          try { rmSync(conn.socket); } catch { /* ok */ }
          connections.delete(key);
        }
      } catch {
        // Transient error — leave the entry in place
      }
    })());
  }
  await Promise.all(pruneChecks);
}

async function findConnection(host: string): Promise<Connection | undefined> {
  await syncFromDiskAsync();
  const s = host.toLowerCase();
  // Exact match first: alias or key
  for (const [, c] of connections) {
    if (c.alias.toLowerCase() === s || c.key.toLowerCase() === s) return c;
  }
  // Substring match as fallback — require exactly one match to avoid ambiguity
  const substringMatches: Array<[string, Connection]> = [];
  for (const [key, c] of connections) {
    if (c.key.toLowerCase().includes(s) || c.alias.toLowerCase().includes(s)) {
      substringMatches.push([key, c]);
    }
  }
  if (substringMatches.length === 1) {
    return substringMatches[0][1];
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
  saveRemoteTasks();
  ctx.ui.notify(`Closed ${c.key}.`, "info");
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  _sshPi = pi;

  if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });

  // ── interceptor: block raw remote ssh ────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    // Block any tool call with timeout >300s — model must use background mode
    const rawTimeout = (event.input as any)?.timeout;
    if (rawTimeout !== undefined && rawTimeout !== null) {
      let effectiveSeconds: number | undefined;
      if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) {
        // pi's bash tool uses seconds; ssh_exec and others use ms — normalize to seconds
        effectiveSeconds = event.toolName === "bash" ? rawTimeout : rawTimeout / 1000;
      }
      if (effectiveSeconds === undefined && typeof rawTimeout === "string") {
        const m = String(rawTimeout).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
        if (m) {
          const val = parseFloat(m[1]);
          if (val > 0) {
            const unit = (m[2] || (event.toolName === "bash" ? "s" : "ms")).toLowerCase();
            const mult: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
            effectiveSeconds = val * (mult[unit] || 1);
          }
        }
      }
      if (effectiveSeconds !== undefined && effectiveSeconds > 300 && !(event.input as any)?.background) {
        return { block: true, reason: `Timeout ${Math.round(effectiveSeconds)}s exceeds max synchronous limit (300s). Use background:true or timeout<=300.` };
      }
    }

    if (event.toolName !== "bash") return;
    const cmd = ((event.input as any)?.command || "") as string;
    if (/\bsshpass\b/.test(cmd)) {
      return { block: true, reason: "sshpass blocked. Use ssh_exec or scp_to_remote/scp_from_remote." };
    }
    const words = cmd.split(/\s+/);
    // Match any command that ENDS with one of the blocked tools (catches /usr/bin/ssh, ./ssh, etc.)
    const idx = words.findIndex(w => /(?:^|\/)(ssh|sshpass|scp|sftp|rsync)$/.test(w));
    if (idx >= 0 && /\S+@\S+/.test(words.slice(idx, idx + 12).join(" "))) {
      return { block: true, reason: "Remote ssh/scp/rsync blocked. Use ssh_exec (commands) or scp_to_remote/scp_from_remote (files)." };
    }
  });

  // ── /ssh command ─────────────────────────────────────────────────────
  pi.registerCommand("ssh", {
    description: "SSH with persistent connections. /ssh [-p PORT] user@host [command]  |  status  |  close <host>",
    handler: async (args, ctx) => {
      if (!args?.trim()) { ctx.ui.notify("/ssh [-p PORT] user@host [command]", "warning"); return; }
      if (args.trim() === "status") { await syncFromDiskAsync(); await showStatus(ctx); return; }
      if (args.trim().startsWith("close ")) { closeConn(args.trim().slice(6).trim(), ctx); return; }
      const p = parseArgs(args);
      if (!p) { ctx.ui.notify("Invalid syntax.", "error"); return; }
      if (p.command) {
        await runRemote(p.alias, p.user, p.hostname, p.port, p.command, ctx);
      } else {
        await connect(p.alias, p.user, p.hostname, p.port, ctx);
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
      "MANDATORY: Commands with timeout >300s are blocked — you MUST set background:true or use a timeout <=300000.",
      "After background ssh_exec, use another ssh_exec to check progress: 'cat /tmp/task.log' or 'ps aux | grep PID'.",
      "Call ssh_status before running ssh_exec to verify the target host is connected.",
      "If no connection exists, tell the user: /ssh <host>",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias" }),
      command: Type.String({ description: "Command to execute on the remote server" }),
      timeout: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Timeout in ms (default: 120000 = 2 min). Accepts numeric ms or suffixed strings like '60s', '10m'" })),
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

      if (!params.host || !params.host.trim()) {
        return { content: [{ type: "text", text: "Host is required — specify an SSH host alias." }], details: {}, isError: true };
      }
      const conn = await findConnection(params.host);
      if (!conn) {
        return { content: [{ type: "text", text: `No connection matching "${params.host}". Connect: /ssh ${params.host}` }], details: {}, isError: true };
      }
      if (!(await isConnectedAsync(conn.key))) {
        if (conn.proc) { try { conn.proc.kill(); } catch { /* ok */ } }
        connections.delete(conn.key);
        // Clean up stale socket
        try { rmSync(conn.socket); } catch { /* ok */ }
        return { content: [{ type: "text", text: `Connection stale. Reconnect: /ssh ${conn.alias}` }], details: {}, isError: true };
      }
      try {
        // Reject non-positive timeout values early before any parsing
        if (typeof params.timeout === "number" && params.timeout <= 0) {
          return { content: [{ type: "text", text: `Invalid timeout: ${params.timeout}. Timeout must be a positive number (ms) or a string like '60s'.` }], details: {}, isError: true };
        }
        if (typeof params.timeout === "string" && /^\s*-/.test(params.timeout)) {
          return { content: [{ type: "text", text: `Invalid timeout: "${params.timeout}". Timeout must be a positive value like '60s' or '10000'.` }], details: {}, isError: true };
        }
        // Block timeouts >300s — model must explicitly use background mode for long tasks
        let effectiveTimeout: number | undefined = typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0 ? params.timeout : undefined;
        // Handle string timeouts like "10000s" or "10m" that models sometimes pass
        if (effectiveTimeout === undefined && typeof params.timeout === "string") {
          const m = (params.timeout as string).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
          if (m) {
            const val = parseFloat(m[1]);
            // Reject zero and negative values in string format (e.g., "0", "0s", "0ms")
            if (val <= 0) {
              return { content: [{ type: "text", text: `Invalid timeout: "${params.timeout}". Timeout must be a positive value like '60s' or '10000'.` }], details: {}, isError: true };
            }
            // Default to seconds for bare number strings (matching pi's convention).
            // Explicit suffixes ("10s", "5m", "2h") override. Internally stored as ms.
            const unit = (m[2] || "s").toLowerCase();
            const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
            effectiveTimeout = Math.round(val * (multipliers[unit] || 1000));
          } else {
            // String didn't match expected format — return error instead of silently defaulting
            return { content: [{ type: "text", text: `Invalid timeout format: "${params.timeout}". Expected a number (ms) or suffixed string like '60s', '10m', '2h'.` }], details: {}, isError: true };
          }
        }
        if (effectiveTimeout === undefined) effectiveTimeout = 120_000;
        if (effectiveTimeout > 300_000 && !params.background) {
          return {
            content: [{
              type: "text",
              text: `Timeout ${Math.round(effectiveTimeout / 1000)}s exceeds max synchronous limit (300s). Use one of:\n` +
                `- Set background: true to run as nohup on remote\n` +
                `- Or use a timeout <= 300000 (5 min) for synchronous execution`,
            }],
            details: { blocked: true },
          };
        }

        const isBg = params.background === true;

        if (isBg) {
          // Deduplicate: use a lock set to prevent TOCTOU races between check and push.
          // The lock key is host+command to allow unrelated hosts/commands to proceed.
          const bgLockKey = `${params.host}\x00${params.command}`;
          // Wait for lock if another call is currently spawning the same (host, command)
          const lockDeadline = Date.now() + 15_000;
          while (spawningRemoteBg.has(bgLockKey)) {
            // Re-check dedup while waiting — the other call may have finished
            const existing = remoteTasks.find(t => t.host === params.host && t.cmd === params.command);
            if (existing) {
              return {
                content: [{
                  type: "text",
                  text: `Background task already running on ${conn!.key}.\n` +
                    `Log: ${existing.logPath}\n` +
                    `Check progress: ssh_exec("${params.host}", "tail -20 ${existing.logPath}")`,
                }],
                details: { logPath: existing.logPath, deduplicated: true },
              };
            }
            if (Date.now() > lockDeadline) {
              // Lock holder may have crashed — break through
              spawningRemoteBg.delete(bgLockKey);
              break;
            }
            await new Promise(r => setTimeout(r, 100));
          }
          spawningRemoteBg.add(bgLockKey);
          // Double-check after acquiring the lock
          const existingAfterLock = remoteTasks.find(t => t.host === params.host && t.cmd === params.command);
          if (existingAfterLock) {
            spawningRemoteBg.delete(bgLockKey);
            return {
              content: [{
                type: "text",
                text: `Background task already running on ${conn!.key}.\n` +
                  `Log: ${existingAfterLock.logPath}\n` +
                  `Check progress: ssh_exec("${params.host}", "tail -20 ${existingAfterLock.logPath}")`,
              }],
              details: { logPath: existingAfterLock.logPath, deduplicated: true },
            };
          }

          // Long-running task: register BEFORE await to prevent concurrent dedup misses
          const logPath = `/tmp/pi-bg-${Date.now().toString(36)}.log`;
          remoteTasks.push({ host: params.host, logPath, cmd: params.command, pid: null, startTime: Date.now() });
          saveRemoteTasks();

          try {
            const bgCmd = `nohup bash -c '${params.command.replace(/'/g, "'\\''")}' > ${logPath} 2>&1 & echo PID=$!`;
            const result = await shellExec(conn, bgCmd, 15000);
            conn.lastUse = Date.now();

            // Extract PID from result for liveness checks during polling
            // Use LAST match of PID= in the result (command output may contain earlier spurious matches)
            let pidMatch: RegExpExecArray | null = null;
            let match: RegExpExecArray | null;
            const pidRe = /PID=(\d+)/g;
            while ((match = pidRe.exec(result)) !== null) {
              pidMatch = match;
            }
            const pid = pidMatch ? pidMatch[1] : null;

            // Poll remote log and inject result when done
            pollRemoteTask(logPath, params.command, params.host, pid);

            return {
              content: [{
                type: "text",
                text: `Background task started on ${conn.key}.\n` +
                  `${result.trim()}\n` +
                  `Log: ${logPath}\n` +
                  `Check progress: ssh_exec("${params.host}", "tail -20 ${logPath}")\n` +
                  `Read full log: ssh_exec("${params.host}", "cat '${logPath}'")`,
              }],
              details: { pid, logPath },
            };
          } catch (spawnErr: any) {
            // shellExec failed — clean up phantom remote task entry
            const idx = remoteTasks.findIndex(t => t.logPath === logPath);
            if (idx >= 0) { remoteTasks.splice(idx, 1); saveRemoteTasks(); }
            throw spawnErr;
          } finally {
            spawningRemoteBg.delete(bgLockKey);
          }
        }
        const result = await shellExec(conn, params.command, Math.min(effectiveTimeout, 600_000));
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
      await syncFromDiskAsync();
      const conn = await findConnection(params.host);
      if (!conn) return { content: [{ type: "text", text: `No connection. Connect: /ssh ${params.host}` }], details: {}, isError: true };
      if (!(await isConnectedAsync(conn.key))) return { content: [{ type: "text", text: "Connection stale. Reconnect." }], details: {}, isError: true };
      // Validate local path before spawning scp
      if (!existsSync(params.localPath)) {
        return { content: [{ type: "text", text: `Local file not found: ${params.localPath}` }], details: {}, isError: true };
      }
      if (statSync(params.localPath).isDirectory()) {
        return { content: [{ type: "text", text: `Local path is a directory, not a file: ${params.localPath}` }], details: {}, isError: true };
      }
      try {
        // ControlMaster handles the connection — just use alias:path
        const scpArgs = [
          "-o", `ControlPath=${conn.socket}`,
          "-o", "ConnectTimeout=5",
          "-o", "LogLevel=ERROR",
          params.localPath,
          `${conn.alias}:${params.remotePath}`,
        ];
        const result = await spawnAsync("scp", scpArgs, { timeout: 300_000 });
        if (result.status !== 0) throw new Error(result.stderr || `scp exited with code ${result.status}`);
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: `Copied: ${params.localPath} → ${conn.alias}:${params.remotePath}\n${result.stdout || "OK"}` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
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
      await syncFromDiskAsync();
      const conn = await findConnection(params.host);
      if (!conn) return { content: [{ type: "text", text: `No connection. Connect: /ssh ${params.host}` }], details: {}, isError: true };
      if (!(await isConnectedAsync(conn.key))) return { content: [{ type: "text", text: "Connection stale. Reconnect." }], details: {}, isError: true };
      // Validate local destination before spawning scp
      try {
        // Use path.dirname for robust directory extraction (handles trailing /, ../, etc.)
        const destDir = dirname(params.localPath) || ".";
        if (!existsSync(destDir)) {
          return { content: [{ type: "text", text: `Local destination directory not found: ${destDir}` }], details: {}, isError: true };
        }
      } catch { /* stat may fail for exotic paths — let scp report the error */ }
      try {
        // ControlMaster handles the connection — just use alias:path
        const scpArgs = [
          "-o", `ControlPath=${conn.socket}`,
          "-o", "ConnectTimeout=5",
          "-o", "LogLevel=ERROR",
          `${conn.alias}:${params.remotePath}`,
          params.localPath,
        ];
        const result = await spawnAsync("scp", scpArgs, { timeout: 300_000 });
        if (result.status !== 0) throw new Error(result.stderr || `scp exited with code ${result.status}`);
        conn.lastUse = Date.now();
        return { content: [{ type: "text", text: `Copied: ${conn.alias}:${params.remotePath} → ${params.localPath}\n${result.stdout || "OK"}` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
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
      await syncFromDiskAsync();
      if (connections.size === 0) return { content: [{ type: "text", text: "No active SSH connections." }], details: {} };
      const lines = ["Active SSH connections:"];
      for (const [, c] of connections) lines.push(`  ${await isConnectedAsync(c.key) ? "🟢" : "⚫"} ${c.key}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── session_start: recover running remote tasks ─────────────────
  pi.on("session_start", async () => {
    await syncFromDiskAsync();
    loadRemoteTasks();
    const now = Date.now();
    const MAX_TASK_AGE = 60 * 60 * 1000; // 1 hour — older tasks are considered stale
    // Build a set of logPaths to remove (avoids findIndex-in-loop fragility)
    const toRemove = new Set<string>();
    for (const t of remoteTasks) {
      if (now - t.startTime > MAX_TASK_AGE) {
        toRemove.add(t.logPath);
        continue;
      }
      const conn = await findConnection(t.host);
      if (conn && await isConnectedAsync(conn.key)) {
        // pollRemoteTask will start a fresh loop (pollRemoteActive dedup prevents duplicates)
        pollRemoteTask(t.logPath, t.cmd, t.host, t.pid);
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
    saveRemoteTasks();
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
    // Persist remote tasks before clearing so session_start can recover them
    saveRemoteTasks();
    // Clear remote task tracking to prevent stale poll loops from continuing
    remoteTasks.length = 0;
    pollRemoteActive.clear();
  });
}

// ── runRemote helper ────────────────────────────────────────────────────────

async function runRemote(alias: string, user: string, hostname: string, port: number, command: string, ctx: any): Promise<void> {
  const key = connKey(user, hostname, port);
  if (!(await isConnectedAsync(key))) { ctx.ui.notify(`No connection. /ssh ${alias} first.`, "warning"); return; }
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

async function showStatus(ctx: any): Promise<void> {
  if (connections.size === 0) { ctx.ui.notify("No connections.", "info"); return; }
  const lines = await Promise.all([...connections.entries()].map(async ([k, c]) => `│ ${await isConnectedAsync(c.key) ? "🟢" : "⚫"} ${k}`));
  ctx.ui.setWidget("ssh-status", lines);
}
