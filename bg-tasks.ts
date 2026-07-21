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
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TASK_DIR = join(homedir(), ".pi", "agent", "tasks");
const TASK_FILE = join(TASK_DIR, "tasks.json");

interface Task {
  id: string;
  description: string;
  status: "running" | "done" | "error" | "killed";
  startTime: number;
  endTime?: number;
  exitCode?: number;
  logFile: string;
  model?: string;
}

// ── persist tasks to disk ──────────────────────────────────────────────────

function loadTasks(): Map<string, Task> {
  const m = new Map<string, Task>();
  try {
    if (existsSync(TASK_FILE)) {
      for (const t of JSON.parse(readFileSync(TASK_FILE, "utf-8"))) m.set(t.id, t);
    }
  } catch { /* ignore */ }
  return m;
}

function saveTasks(tasks: Map<string, Task>): void {
  mkdirSync(TASK_DIR, { recursive: true });
  writeFileSync(TASK_FILE, JSON.stringify([...tasks.values()], null, 2));
}

const tasks = loadTasks();
let _pi: ExtensionAPI | null = null;

function notifyUser(msg: string, type: "info" | "warning" | "error" = "info"): void {
  try { _pi?.ui?.notify?.(msg, type); } catch { /* ignore */ }
}

// ── spawn background task ──────────────────────────────────────────────────

function spawnTask(description: string, cwd: string, timeout: number): Task {
  const id = `task-${Date.now().toString(36)}`;
  const logFile = join(TASK_DIR, `${id}.log`);
  mkdirSync(TASK_DIR, { recursive: true });

  const startTime = Date.now();
  const task: Task = { id, description, status: "running", startTime, logFile };
  tasks.set(id, task);
  saveTasks(tasks);

  // Write script to temp file to avoid shell escaping issues
  const scriptFile = join(TASK_DIR, `${id}.sh`);
  const script = [
    `cd "${cwd}"`,
    `( ${description} ) > "${logFile}" 2>&1`,
    `echo "EXIT_CODE=$?" >> "${logFile}"`,
  ].join("\n");
  writeFileSync(scriptFile, script);

  execSync(`tmux new-session -d -s "${id}" "bash ${scriptFile} ; rm -f ${scriptFile}" 2>/dev/null`, { timeout: 10_000 });

  // Poll for completion and notify
  pollCompletion(id);

  if (timeout > 0) {
    setTimeout(() => {
      const t = tasks.get(id);
      if (t && t.status === "running") {
        try { execSync(`tmux kill-session -t "${id}" 2>/dev/null`, { timeout: 5_000 }); } catch { /* ok */ }
        t.status = "killed";
        t.endTime = Date.now();
        saveTasks(tasks);
      }
    }, timeout);
  }

  return task;
}

function getTaskOutput(task: Task): string {
  if (!existsSync(task.logFile)) return "(no output yet)";
  try {
    const content = readFileSync(task.logFile, "utf-8");
    const exitMatch = content.match(/EXIT_CODE=(\d+)/);
    if (exitMatch && task.status === "running") {
      task.exitCode = parseInt(exitMatch[1], 10);
      task.status = task.exitCode === 0 ? "done" : "error";
      task.endTime = Date.now();
      saveTasks(tasks);
    }
    return content;
  } catch { return "(cannot read)"; }
}

function killTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  try { execSync(`tmux kill-session -t "${id}" 2>/dev/null`, { timeout: 5_000 }); } catch { /* ok */ }
  task.status = "killed";
  task.endTime = Date.now();
  saveTasks(tasks);
  return true;
}

function pollCompletion(id: string): void {
  const check = () => {
    const task = tasks.get(id);
    if (!task || task.status !== "running") return;
    try {
      execSync(`tmux has-session -t "${id}" 2>/dev/null`, { stdio: "ignore", timeout: 3_000 });
      // Still running — check again in 3s
      setTimeout(check, 5000);
    } catch {
      // Session ended
      const output = getTaskOutput(task);
      tasks.set(id, task);
      saveTasks(tasks);
      const emoji = task.status === "done" ? "✅" : "❌";
      notifyUser(`${emoji} Background task ${id} completed (${task.status})`, task.status === "done" ? "info" : "error");
      // Send result as new user input so AI can process it
      try {
        if (_pi) {
          const msg = [
            { type: "text", text: `[Background task ${id} completed (${task.status})]` },
            { type: "text", text: `Task: ${task.description.substring(0, 200)}` },
            { type: "text", text: `Output:\n${output.substring(0, 4000)}` },
          ];
          _pi.sendUserMessage(msg, { deliverAs: "followUp" });
        }
      } catch { /* ignore */ }
    }
  };
  setTimeout(check, 5000);
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  _pi = pi;

  // Sync running tasks with actual tmux sessions on startup
  function syncTasks(): void {
    for (const [id, task] of tasks) {
      if (task.status !== "running") continue;
      try {
        execSync(`tmux has-session -t "${id}" 2>/dev/null`, { stdio: "ignore", timeout: 5_000 });
        // Still running — resume polling
        pollCompletion(id);
      } catch {
        // Session gone — check log for exit code
        getTaskOutput(task);
        saveTasks(tasks);
      }
    }
  }
  syncTasks();

  // ── /tasks command ────────────────────────────────────────────────────
  pi.registerCommand("tasks", {
    description: "List background tasks",
    handler: async (_args, ctx) => {
      syncTasks();
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

      const output = getTaskOutput(task);
      ctx.ui.setWidget("task-" + id, [
        `┌─ ${id} [${task.status}] ${(task.exitCode != null ? ` exit=${task.exitCode}` : "")}`,
        ...output.split("\n").slice(0, 50).map((l: string) => `│ ${l.substring(0, 80)}`),
        output.split("\n").length > 50 ? `│ ...` : "",
        `└─`.replace(/_/g, "─"),
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
      await new Promise<void>(r => proc.on("exit", () => r()));
      syncTasks();
    },
  });

  // ── /kill command ─────────────────────────────────────────────────────
  pi.registerCommand("kill", {
    description: "Kill a background task",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) { ctx.ui.notify("Usage: /kill <task-id>", "warning"); return; }
      if (killTask(id)) ctx.ui.notify(`Killed ${id}.`, "info");
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
      const task = spawnTask(params.task, ctx.cwd, params.timeoutMs || 3_600_000); // default 60 min
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
      syncTasks();
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
  pi.on("session_start", () => syncTasks());

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
