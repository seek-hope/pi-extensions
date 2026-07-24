/**
 * Background Tasks — Claude Code-style tmux-based background execution.
 *
 * Every task gets a tmux session. Output goes to files on disk.
 * Tasks survive session restarts. The AI polls output via read.
 *
 * Commands: /tasks  /fg <id>  /kill <id>  /attach <id>
 * Tools:    bg_spawn  bg_status  bg_output
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { readFile, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const TASK_DIR = join(homedir(), ".pi", "agent", "tasks");
const TASK_FILE = join(TASK_DIR, "tasks.json");

interface Task {
  id: string;
  description: string;
  cwd: string;
  status: "running" | "done" | "error" | "killed";
  startTime: number;
  endTime?: number;
  exitCode?: number;
  logFile: string;
  model?: string;
  timeout?: number;
}

// ── persist tasks to disk ──────────────────────────────────────────────────

function loadTasks(): Map<string, Task> {
  const m = new Map<string, Task>();
  try {
    if (existsSync(TASK_FILE)) {
      for (const t of JSON.parse(readFileSync(TASK_FILE, "utf-8"))) m.set(t.id, t);
    }
  } catch (err) {
    // If tasks.json is corrupted, log a warning and fall back to log-file-only recovery.
    // The task completion poller will detect EXIT_CODE in the log files on next check.
    console.warn(`bg-tasks: failed to load ${TASK_FILE} — ${(err as Error)?.message || String(err)}. Tasks will be recovered from log files on next poll.`);
    try {
      // Attempt backup: append .corrupt suffix so the file isn't silently overwritten
      const bak = TASK_FILE + ".corrupt." + Date.now();
      writeFileSync(bak, readFileSync(TASK_FILE));
      console.warn(`bg-tasks: backed up corrupted tasks.json to ${bak}`);
    } catch { /* backup also failed — proceed without */ }
  }
  return m;
}

function saveTasks(tasks: Map<string, Task>): void {
  mkdirSync(TASK_DIR, { recursive: true });
  writeFileSync(TASK_FILE, JSON.stringify([...tasks.values()], null, 2));
}

let spawnCounter = 0;
const tasks = loadTasks();
const pollingTasks = new Set<string>(); // tracks which task IDs are currently being polled
const spawningLocks = new Set<string>(); // guards spawnTask dedup against TOCTOU races
const spawningScripts = new Set<string>(); // guards task script cleanup against in-flight spawns
const taskTimers = new Map<string, NodeJS.Timeout>(); // timeout handles per task, cleared on completion
let _pi: ExtensionAPI | null = null;

/** Check whether a tmux session with the given id still exists.
 *  Returns `true` if alive, `false` if definitively dead (exit code != 0),
 *  or `"error"` if the check itself failed (timeout, tmux not found, etc.). */
async function tmuxHasSession(id: string): Promise<boolean | "error"> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tmux", ["has-session", "-t", id], { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("timed out")); }, 5_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`tmux has-session exited with code ${code}`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return true;
  } catch (e: any) {
    if (e.message === "timed out" || e.code === "ENOENT" || e.code === "EACCES") {
      return "error";
    }
    return false;
  }
}

const MAX_LOG_READ = 1024 * 1024; // 1MB max read per task log

async function tmuxKillSession(id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn("tmux", ["kill-session", "-t", id], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5_000);
    child.on("close", () => { clearTimeout(timer); resolve(); });
    child.on("error", () => { clearTimeout(timer); resolve(); });
  });
}

/** Read a task log file with a size cap to prevent OOM on multi-GB output */
async function readTaskLog(filePath: string): Promise<string> {
  const stats = await stat(filePath);
  if (stats.size <= MAX_LOG_READ) {
    return await readFile(filePath, "utf-8");
  }
  // Read last MAX_LOG_READ bytes (where EXIT_CODE marker and recent output lives)
  const fd = await open(filePath, "r");
  const buf = Buffer.alloc(MAX_LOG_READ);
  await fd.read(buf, 0, MAX_LOG_READ, stats.size - MAX_LOG_READ);
  await fd.close();
  // Skip UTF-8 continuation bytes at the start of the buffer to avoid corrupting
  // multi-byte characters that straddle the read boundary (U+FFFD replacement).
  let start = 0;
  while (start < buf.length && (buf[start] & 0xC0) === 0x80) start++;
  return buf.toString("utf-8", start, buf.length);
}

function notifyUser(msg: string, type: "info" | "warning" | "error" = "info"): void {
  try { _pi?.ui?.notify?.(msg, type); } catch { /* ignore */ }
}

// ── spawn background task ──────────────────────────────────────────────────

async function spawnTask(description: string, cwd: string, timeout: number): Promise<Task> {
  const lockKey = createHash("sha256").update(description).update("\0").update(cwd).update("\0").update(String(timeout)).digest("hex").slice(0, 16);
  // Deduplicate: if identical task (same description, cwd, and timeout) already running, return existing.
  // Verify the tmux session is actually still alive before deduplicating.
  for (const [, t] of tasks) {
    if (t.status === "running" && t.description === description && t.cwd === cwd && t.timeout === timeout) {
      const alive = await tmuxHasSession(t.id);
      if (alive === true) return t; // session confirmed alive — deduplicate
      if (alive === "error") continue; // check failed — can't confirm; don't mark as dead
      // Session is dead — stale status. Mark it and continue to spawn a new one.
      t.status = "error";
      t.exitCode = -1;
      t.endTime = Date.now();
      saveTasks(tasks);
    }
  }
  // Guard against TOCTOU: atomically check-and-acquire the lock (no await between check and add).
  // This prevents two concurrent spawns for the same (desc, cwd) from both passing the gate.
  const deadline = Date.now() + 10_000;
  while (true) {
    if (!spawningLocks.has(lockKey)) {
      spawningLocks.add(lockKey);
      // Double-check: another call may have inserted the task just before we acquired the lock
      // (race — the original lock holder finished its spawn after we deemed the lock stale)
      const taskAfterLock = [...tasks.values()].find(
        t => t.status === "running" && t.description === description && t.cwd === cwd && t.timeout === timeout
      );
      if (taskAfterLock) {
        spawningLocks.delete(lockKey);
        return taskAfterLock;
      }
      break;
    }
    // Lock held by another call — wait for its task to appear or lock to release
    const existing = [...tasks.values()].find(
      t => t.status === "running" && t.description === description && t.cwd === cwd && t.timeout === timeout
    );
    if (existing) return existing;
    if (Date.now() > deadline) {
      // Deadline reached — lock holder may have crashed. Check if task appeared.
      const existing = [...tasks.values()].find(
        t => t.status === "running" && t.description === description && t.cwd === cwd && t.timeout === timeout
      );
      if (existing) return existing;
      // Stale lock — remove it and retry with backoff
      spawningLocks.delete(lockKey);
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    // Async yield to let the other call proceed without blocking the event loop
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try {
    const id = `task-${Date.now().toString(36)}-${String(spawnCounter++).padStart(3, '0')}`;
    const logFile = join(TASK_DIR, `${id}.log`);
    mkdirSync(TASK_DIR, { recursive: true });

    const startTime = Date.now();

    // Write the task command to a standalone script file — avoids shell escaping
    // and heredoc-marker collision issues entirely.
    const taskScript = join(TASK_DIR, `${id}.sh`);
    const wrapperScript = [
      `cd '${cwd.replace(/'/g, "'\\''")}'`,
      `bash '${taskScript.replace(/'/g, "'\\''")}' > "${logFile.replace(/'/g, "'\\''")}" 2>&1`,
      `echo "EXIT_CODE=$?" >> "${logFile.replace(/'/g, "'\\''")}"`,
    ].join("\n");
    writeFileSync(taskScript, description);
    const wrapperFile = join(TASK_DIR, `${id}_wrapper.sh`);
    writeFileSync(wrapperFile, wrapperScript);
    spawningScripts.add(id);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("tmux", ["new-session", "-d", "-s", id,
          `bash '${wrapperFile.replace(/'/g, "'\\''")}' ; rm -f '${wrapperFile.replace(/'/g, "'\\''")}' '${taskScript.replace(/'/g, "'\\''")}'`
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => { child.kill(); reject(new Error("tmux new-session timed out")); }, 10_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`tmux new-session exited with code ${code}`));
        });
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
    } catch {
      // tmux spawn failed — clean up and throw
      spawningScripts.delete(id);
      try { unlinkSync(taskScript); } catch { /* ok */ }
      try { unlinkSync(wrapperFile); } catch { /* ok */ }
      throw new Error(`Failed to start tmux session for task ${id}`);
    }

    const task: Task = { id, description, cwd, status: "running", startTime, logFile, timeout };
    tasks.set(id, task);
    spawningScripts.delete(id);
    saveTasks(tasks);

    // Poll for completion and notify
    pollCompletion(id);

    if (timeout > 0) {
      const timer = setTimeout(async () => {
        try {
          const t = tasks.get(id);
          if (t && t.status === "running") {
            // Check if task already completed (EXIT_CODE written after last poll cycle)
            try { await finalizeTaskOutput(t); } catch { /* finalize failed — fall through to kill */ }
            if (t.status !== "running") {
              // Task finished just before timeout — don't kill, let normal flow handle output delivery
              pollingTasks.delete(id);
              taskTimers.delete(id);
              saveTasks(tasks);
              updateTaskWidget();
              return;
            }
            try { await tmuxKillSession(id); } catch { /* ok */ }
            t.status = "killed";
            t.endTime = Date.now();
            pollingTasks.delete(id);
            taskTimers.delete(id);
            // Clean up script files that the tmux session would have removed on normal exit
            try { unlinkSync(wrapperFile); } catch { /* ok */ }
            try { unlinkSync(taskScript); } catch { /* ok */ }
            saveTasks(tasks);
            updateTaskWidget();
          } else {
            // Task already completed (status !== "running") or was deleted — clean up timer entry
            taskTimers.delete(id);
          }
        } catch {
          // Unexpected error in timeout handler — kill session to prevent stuck tasks
          const t = tasks.get(id);
          if (t && t.status === "running") {
            try { await tmuxKillSession(id); } catch { /* ok */ }
            t.status = "killed";
            t.endTime = Date.now();
            pollingTasks.delete(id);
            taskTimers.delete(id);
            try { unlinkSync(wrapperFile); } catch { /* ok */ }
            try { unlinkSync(taskScript); } catch { /* ok */ }
            saveTasks(tasks);
            updateTaskWidget();
          }
        }
      }, timeout);
      taskTimers.set(id, timer);
    }

    return task;
  } finally {
    spawningLocks.delete(lockKey);
  }
}

/**
 * Read a task's log file and finalize its status if EXIT_CODE was found.
 * Despite its getter-like name, this mutates task.status/task.exitCode/task.endTime
 * when it detects that the background process has finished.
 */
async function finalizeTaskOutput(task: Task): Promise<string> {
  if (!existsSync(task.logFile)) return "(no output yet)";
  try {
    const content = await readTaskLog(task.logFile);
    // Match the LAST EXIT_CODE= in the log (the actual exit code is appended as the last line
    // by the wrapper script, but command output may contain earlier spurious matches).
    let exitMatch = null;
    let match;
    const re = /EXIT_CODE=(\d+)/g;
    while ((match = re.exec(content)) !== null) {
      exitMatch = match;
    }
    if (exitMatch && task.status === "running") {
      task.exitCode = parseInt(exitMatch[1], 10);
      task.status = task.exitCode === 0 ? "done" : "error";
      task.endTime = Date.now();
      // Don't save here — caller handles persistence to avoid double-writes
    }
    return content;
  } catch { return "(cannot read)"; }
}

async function killTask(id: string): Promise<boolean> {
  const task = tasks.get(id);
  if (!task) {
    // Task not in Map — might be in the spawn window (scripts written, tmux running,
    // but task entry not yet created). Try to kill the tmux session directly.
    const sessionExists = await tmuxHasSession(id);
    if (sessionExists === true) {
      await tmuxKillSession(id);
      try { unlinkSync(join(TASK_DIR, `${id}.sh`)); } catch { /* ok */ }
      try { unlinkSync(join(TASK_DIR, `${id}_wrapper.sh`)); } catch { /* ok */ }
      return true;
    }
    return false;
  }
  await tmuxKillSession(id);
  task.status = "killed";
  task.endTime = Date.now();
  pollingTasks.delete(id);
  clearTimeout(taskTimers.get(id));
  taskTimers.delete(id);
  // Clean up script files that the tmux session would have removed on normal exit
  try { unlinkSync(join(TASK_DIR, `${id}.sh`)); } catch { /* ok */ }
  try { unlinkSync(join(TASK_DIR, `${id}_wrapper.sh`)); } catch { /* ok */ }
  saveTasks(tasks);
  updateTaskWidget();
  return true;
}

function updateTaskWidget(): void {
  try {
    const running: string[] = [];
    for (const [id, t] of tasks) {
      if (t.status === "running") {
        const elapsed = ((Date.now() - t.startTime) / 60000).toFixed(0);
        running.push(`🔄 ${id}: ${t.description.substring(0, 40)} (${elapsed}m)`);
      }
    }
    if (running.length === 0) {
      _pi?.ui?.setWidget?.("bg-tasks", []);
    } else if (running.length <= 3) {
      _pi?.ui?.setWidget?.("bg-tasks", [`│ ${running.join("  │  ")}`, `│ /tasks to manage, /fg <id> for output`]);
    } else {
      _pi?.ui?.setWidget?.("bg-tasks", [`│ ${running.length} tasks running`, `│ /tasks to list, /fg <id> for output`]);
    }
  } catch { /* best effort */ }
}

const MAX_POLL_ERRORS = 5;

function pollCompletion(id: string): void {
  // Prevent duplicate polling chains for the same task
  if (pollingTasks.has(id)) return;
  pollingTasks.add(id);

  let consecutiveErrors = 0;

  const check = async () => {
    try {
      const task = tasks.get(id);
      if (!task || task.status !== "running") {
        pollingTasks.delete(id);
        clearTimeout(taskTimers.get(id));
        taskTimers.delete(id);
        return;
      }
      // Use stdio:'pipe' so we can distinguish "session not found" (exit 1)
      // from other tmux failures (tmux not installed, etc.)
      let sessionExists = await tmuxHasSession(id);
      if (sessionExists === true) {
        consecutiveErrors = 0; // reset on success
      } else if (sessionExists === "error") {
        // tmux check itself failed (timeout, ENOENT, etc.) — we don't know if the session exists.
        // Retry with a cap on consecutive errors.
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_POLL_ERRORS) {
          // Too many consecutive errors — abort polling, mark task as error
          const msg = `❌ Background task ${id} failed: tmux unavailable or too many errors (${consecutiveErrors})`;
          task.status = "error";
          task.exitCode = -1;
          task.endTime = Date.now();
          pollingTasks.delete(id);
          clearTimeout(taskTimers.get(id));
          taskTimers.delete(id);
          saveTasks(tasks);
          updateTaskWidget();
          notifyUser(msg, "error");
          return;
        }
        updateTaskWidget();
        setTimeout(check, 2000);
        return;
      }

      if (sessionExists === true) {
        // Still running
        updateTaskWidget();
        setTimeout(check, 2000);
        return;
      }

      // Session ended — atomically get output and update status
      const current = tasks.get(id);
      if (!current || current.status !== "running") {
        pollingTasks.delete(id);
        clearTimeout(taskTimers.get(id));
        taskTimers.delete(id);
        return;
      }
      await finalizeTaskOutput(current);  // attempts to set status to done/error from EXIT_CODE

      // If status is still "running" after finalizeTaskOutput, the log lacks EXIT_CODE
      // (e.g. script was killed before writing it). Mark as error.
      if (current.status === "running") {
        current.status = "error";
        current.exitCode = -1;
        current.endTime = Date.now();
      }

      pollingTasks.delete(id);
      clearTimeout(taskTimers.get(id));
      taskTimers.delete(id);
      saveTasks(tasks);
      let output = "";
      try { output = await readTaskLog(current.logFile); } catch { /* file may have been removed */ }
      const emoji = current.status === "done" ? "✅" : "❌";
      updateTaskWidget();
      notifyUser(`${emoji} Background task ${id} completed (${current.status})`, current.status === "done" ? "info" : "error");
      // Send result as new user input so AI can process it
      try {
        if (_pi && current.status !== "killed") {
          const msg = [
            { type: "text", text: `[Background task ${id} completed (${current.status})]` },
            { type: "text", text: `Task: ${current.description.substring(0, 200)}` },
            { type: "text", text: `Output:\n${output.substring(0, 4000)}` },
          ];
          _pi.sendUserMessage(msg, { deliverAs: "followUp" });
        }
      } catch { /* ignore */ }
    } catch (err) {
      // Unexpected error in poll loop — mark task as error to avoid silent hangs
      const t = tasks.get(id);
      if (t && t.status === "running") {
        t.status = "error";
        t.exitCode = -1;
        t.endTime = Date.now();
        pollingTasks.delete(id);
        clearTimeout(taskTimers.get(id));
        taskTimers.delete(id);
        saveTasks(tasks);
        updateTaskWidget();
        notifyUser(`❌ Background task ${id} failed with unexpected error: ${err instanceof Error ? err.message : err}`, "error");
      }
    }
  };
  setTimeout(check, 2000);
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  _pi = pi;

  let lastGcTime = 0;
  const GC_INTERVAL_MS = 5 * 60 * 1000; // Once per 5 minutes

  // Sync running tasks with actual tmux sessions on startup
  async function syncTasks(): Promise<void> {
    for (const [id, task] of tasks) {
      if (task.status !== "running") continue;
      const sessionExists = await tmuxHasSession(id);
      if (sessionExists === true) {
        // Still running — resume polling
        notifyUser(`🔄 Resumed polling for background task ${id}`, "info");
        pollCompletion(id);
      } else if (sessionExists === "error") {
        // tmux check failed — can't confirm state. Leave as-is for next sync cycle.
        console.debug("syncTasks: tmux check failed for", id, "— will retry on next sync");
      } else {
        // Session gone — check log for exit code
        try {
          await finalizeTaskOutput(task);
        } catch { /* log file may be gone */ }
        // If still "running" after finalizeTaskOutput, the log file is missing
        // or lacks EXIT_CODE. Mark as error to prevent perpetual "running" state.
        if (task.status === "running") {
          task.status = "error";
          task.exitCode = -1;
          task.endTime = Date.now();
        }
        saveTasks(tasks);
        // Notify user if the task completed while we were offline
        if (task.status !== "running") {
          let output = "";
          try { output = await readTaskLog(task.logFile); } catch { /* file may be gone */ }
          try {
            if (_pi) {
              _pi.sendUserMessage([
                { type: "text", text: `[Background task ${task.id} completed (${task.status})]` },
                { type: "text", text: `Task: ${task.description.substring(0, 200)}` },
                { type: "text", text: `Output:\n${output.substring(0, 4000)}` },
              ], { deliverAs: "followUp" });
            }
          } catch { /* ignore */ }
        }
      }
    }
    // Recover orphaned tasks from .log files (survives corrupted tasks.json)
    // IMPORTANT: recovery MUST run before GC of .sh files. If tasks.json is
    // corrupted (empty Map), the GC pass would delete all .sh files, then
    // recovery would skip every orphan because the .sh guard check fails.
    try {
      const files = readdirSync(TASK_DIR);
      const logFiles = files.filter(f => f.endsWith(".log") && !tasks.has(f.slice(0, -".log".length)) && f.startsWith("task-"));
      for (const logFile of logFiles) {
        const taskId = logFile.slice(0, -".log".length);
        const logFilePath = join(TASK_DIR, logFile);

        // Only recover if the .sh script exists — otherwise it's a GC leftover
        // whose .log unlink failed. Recovering it would create an infinite cycle.
        if (!existsSync(join(TASK_DIR, `${taskId}.sh`))) continue;

        // Check if tmux session still exists
        const sessionExists = await tmuxHasSession(taskId);

        // Read log contents and look for EXIT_CODE
        let content = "";
        try { content = await readTaskLog(logFilePath); } catch { /* can't read */ }
        // Use LAST match of EXIT_CODE in the log (command output may contain earlier spurious matches)
        let exitMatch: RegExpExecArray | null = null;
        let match: RegExpExecArray | null;
        const exitRe = /EXIT_CODE=(\d+)/g;
        while ((match = exitRe.exec(content)) !== null) {
          exitMatch = match;
        }

        // Try to recover description from the .sh script file
        let description = "(recovered)";
        try {
          const scriptPath = join(TASK_DIR, `${taskId}.sh`);
          if (existsSync(scriptPath)) {
            description = readFileSync(scriptPath, "utf-8").trim().substring(0, 200);
          }
        } catch { /* ignore */ }

        const idParts = taskId.split("-");
        const startTime = idParts.length > 1 ? parseInt(idParts[1], 36) || Date.now() : Date.now();

        // Calculate remaining runtime for recovered tasks (default 60 min cap)
        const maxRuntime = 3_600_000;
        const elapsed = Date.now() - startTime;
        const remainingTimeout = Math.max(maxRuntime - elapsed, 60_000); // at least 1 min

        const task: Task = {
          id: taskId,
          description,
          cwd: process.cwd(),
          status: sessionExists === true ? "running" : (exitMatch ? (parseInt(exitMatch[1], 10) === 0 ? "done" : "error") : "error"),
          startTime,
          logFile: logFilePath,
          timeout: sessionExists === true ? remainingTimeout : undefined,
        };
        if (exitMatch) {
          task.exitCode = parseInt(exitMatch[1], 10);
          task.endTime = Date.now();
        }
        tasks.set(taskId, task);

        if (sessionExists === true) {
          notifyUser(`🔄 Recovered and resumed polling for background task ${taskId}`, "info");
          pollCompletion(taskId);
        } else {
          // Task already completed — notify user
          let output = "";
          try { output = await readTaskLog(task.logFile); } catch { /* file may be removed */ }
          try {
            if (_pi) {
              _pi.sendUserMessage([
                { type: "text", text: `[Recovered background task ${taskId} (${task.status})]` },
                { type: "text", text: `Task: ${task.description.substring(0, 200)}` },
                { type: "text", text: `Output:\n${output.substring(0, 4000)}` },
              ], { deliverAs: "followUp" });
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* TASK_DIR may not exist */ }

    // GC: remove orphaned .sh and _wrapper.sh files that are not associated
    // with any known task. These accumulate if pi crashes mid-task or the
    // tmux cleanup rm fails, and would otherwise grow unbounded over time.
    // Exclude tasks in spawningScripts (script files written but task not yet in tasks map).
    try {
      const files = readdirSync(TASK_DIR);
      for (const file of files) {
        let taskId: string | null = null;
        if (file.endsWith("_wrapper.sh")) {
          taskId = file.slice(0, -"_wrapper.sh".length);
        } else if (file.endsWith(".sh")) {
          taskId = file.slice(0, -".sh".length);
        } else {
          continue;
        }
        if (!tasks.has(taskId) && !spawningScripts.has(taskId)) {
          // Before deleting, check if a tmux session exists for this ID.
          // If so, the .sh file may be needed for recovery after crash during spawn
          // (scripts written but task entry not yet in map). Keep the file.
          const sessionExists = await tmuxHasSession(taskId);
          if (sessionExists === true) continue;
          try { unlinkSync(join(TASK_DIR, file)); } catch { /* ok */ }
        }
      }
    } catch { /* TASK_DIR may not exist yet */ }

    // GC: remove terminal tasks older than 7 days to prevent unbounded Map growth
    // Throttled to once per GC_INTERVAL_MS to avoid O(n) file I/O on every status check.
    const now = Date.now();
    if (now - lastGcTime > GC_INTERVAL_MS) {
      lastGcTime = now;
      const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      for (const [id, t] of tasks) {
        if (t.status !== "running" && t.endTime && (now - t.endTime) > MAX_AGE_MS) {
          try { unlinkSync(join(TASK_DIR, `${id}.log`)); } catch { /* ok */ }
          try { unlinkSync(join(TASK_DIR, `${id}.sh`)); } catch { /* ok */ }
          try { unlinkSync(join(TASK_DIR, `${id}_wrapper.sh`)); } catch { /* ok */ }
          tasks.delete(id);
        }
      }
    }

    updateTaskWidget();
  }

  // ── /tasks command ────────────────────────────────────────────────────
  pi.registerCommand("tasks", {
    description: "List background tasks",
    handler: async (_args, ctx) => {
      await syncTasks();
      if (tasks.size === 0) { ctx.ui.notify("No background tasks.", "info"); return; }

      const lines = ["Background tasks:"];
      for (const [id, t] of tasks) {
        const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
        const icon = t.status === "done" ? "✅" : t.status === "running" ? "🔄" : "❌";
        lines.push(`  ${icon} ${id}: ${t.description.substring(0, 50)} (${elapsed.toFixed(0)}s)`);
      }
      ctx.ui.setWidget("tasks", lines.map(l => `│ ${l}`));
    },
  });

  // ── /fg command ───────────────────────────────────────────────────────
  pi.registerCommand("fg", {
    description: "View background task output",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) { ctx.ui.notify("Usage: /fg <task-id>", "warning"); return; }
      const task = tasks.get(id);
      if (!task) { ctx.ui.notify(`Task ${id} not found.`, "error"); return; }

      const output = await finalizeTaskOutput(task);
      // Persist any status change that finalizeTaskOutput may have applied
      saveTasks(tasks);
      // Clean up timeout timer if task is no longer running
      if (task.status !== "running") {
        clearTimeout(taskTimers.get(id));
        taskTimers.delete(id);
      }
      const lines = output.split("\n");
      ctx.ui.setWidget("task-" + id, [
        `┌─ ${id} [${task.status}] ${(task.exitCode != null ? ` exit=${task.exitCode}` : "")}`,
        ...lines.slice(0, 10).map((l: string) => `│ ${l.substring(0, 100)}`),
        lines.length > 10 ? `│ ... (${lines.length} lines total, /read ${task.logFile} for full)` : "",
        `└─`,
      ].filter(Boolean));
    },
  });

  // ── /attach command ───────────────────────────────────────────────────
  pi.registerCommand("attach", {
    description: "Attach to live background task tmux session",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) { ctx.ui.notify("Usage: /attach <task-id>", "warning"); return; }
      const task = tasks.get(id);
      if (!task || task.status !== "running") { ctx.ui.notify("Not running.", "error"); return; }

      ctx.ui.notify(`Attaching to ${id}... (Ctrl+B D to detach)`, "info");
      const proc = spawn("tmux", ["attach-session", "-t", id], { stdio: "inherit" });
      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        proc.on("error", () => resolve());
      });
      syncTasks();
    },
  });

  // ── /kill command ─────────────────────────────────────────────────────
  pi.registerCommand("kill", {
    description: "Kill a background task",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) { ctx.ui.notify("Usage: /kill <task-id>", "warning"); return; }
      if (await killTask(id)) ctx.ui.notify(`Killed ${id}.`, "info");
      else ctx.ui.notify(`Task ${id} not found.`, "error");
    },
  });

  // ── bg_spawn tool ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "bg_spawn",
    label: "Background Task",
    description:
      "Start a background task in a tmux session. Returns a task ID and log file path. " +
      "The task continues running even if the session ends. " +
      "Use bg_status to check progress, read the logFile to see output.",
    promptSnippet: "Start a task in background via tmux — survives session end.",
    promptGuidelines: [
      "Use bg_spawn for long-running local tasks (builds, servers, downloads, training).",
      "bg_spawn returns a logFile path — use the read tool to check output anytime.",
      "For remote long-running tasks, use ssh_exec with nohup on the server side.",
      "Tasks survive pi session shutdown. They keep running in tmux.",
      "Use /tasks to see all tasks, /fg <id> to view output, /kill <id> to stop.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Command or task to run in background" }),
      model: Type.Optional(Type.String({ description: "Model override (not applicable for bash commands)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Max runtime in ms (default: 3600000 = 60 min)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Reject negative timeout values — they would silently disable the kill guard
      if (params.timeoutMs != null && (!Number.isFinite(params.timeoutMs) || params.timeoutMs < 0)) {
        return { content: [{ type: "text", text: `Invalid timeoutMs: ${params.timeoutMs}. Timeout must be a finite number >= 0.` }], details: {}, isError: true };
      }
      const task = await spawnTask(params.task, ctx.cwd, params.timeoutMs ?? 3_600_000); // default 60 min
      return {
        content: [{
          type: "text",
          text: [
            `Background task started.`,
            `ID: ${task.id}`,
            `Log: ${task.logFile}`,
            ``,
            `Check: /tasks  |  Output: /fg ${task.id}  |  Live: /attach ${task.id}  |  Kill: /kill ${task.id}`,
          ].join("\n"),
        }],
        details: { taskId: task.id, logFile: task.logFile },
      };
    },
  });

  // ── bg_status tool ────────────────────────────────────────────────────
  pi.registerTool({
    name: "bg_status",
    label: "Background Status",
    description: "Check the status of all background tasks.",
    parameters: Type.Object({}),
    async execute() {
      await syncTasks();
      if (tasks.size === 0) return { content: [{ type: "text", text: "No background tasks." }], details: {} };
      const lines = ["Background tasks:"];
      for (const [id, t] of tasks) {
        const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
        const icon = t.status === "done" ? "✅" : t.status === "running" ? "🔄" : "❌";
        lines.push(`  ${icon} ${id}: ${t.description.substring(0, 60)} (${elapsed.toFixed(0)}s)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── session_start: restore running task awareness ─────────────────────
  pi.on("session_start", async () => { await syncTasks(); });

  // ── tool_call: notify when bash tasks complete ────────────────────────
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    // Check if this was a long-running command (>5s)
    const elapsed = (event.details as any)?.elapsed;
    if (elapsed && elapsed > 5000) {
      ctx.ui.setStatus("last-bash", `✅ bash done (${(elapsed / 1000).toFixed(0)}s)`);
      setTimeout(() => ctx.ui.setStatus("last-bash", ""), 5000);
    }
  });

  // ── session_shutdown: DON'T kill tasks — they survive in tmux ─────────
  pi.on("session_shutdown", () => {
    // Tasks persist across sessions. Don't kill them.
  });
}
