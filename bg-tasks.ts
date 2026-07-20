/**
 * Background Tasks extension — code-enforced tmux-based background execution.
 *
 * Any bash command with timeout >300s is AUTOMATICALLY run in a tmux session.
 * No AI judgment needed — the interceptor enforces it at the tool_call level.
 *
 * The result returns as a new user input when the task completes and the
 * foreground conversation is idle.
 *
 * User commands:
 *   /jobs          list background tasks
 *   /fg <id>       view completed task output
 *   /attach <id>   attach to live tmux session
 *   /kill <id>     kill a background task
 *   /bg            (no args) show status
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── types ───────────────────────────────────────────────────────────────────

interface BgTask {
  id: string;
  cmd: string;
  tmuxSession: string;
  status: "running" | "done" | "error" | "killed";
  startTime: number;
  endTime?: number;
  exitCode?: number;
  logFile: string;
}

const tasks = new Map<string, BgTask>();
const TASK_PREFIX = "pi-bg";

function taskId(): string {
  return `${TASK_PREFIX}-${Date.now().toString(36)}`;
}

// ── tmux helpers ────────────────────────────────────────────────────────────

function tmux(args: string): string {
  try {
    return execSync(`tmux ${args}`, { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch (e: any) {
    return e.stderr || e.message || "";
  }
}

function tmuxHasSession(name: string): boolean {
  return tmux(`has-session -t "${name}" 2>/dev/null`) !== "" || 
         execSync(`tmux has-session -t "${name}" 2>/dev/null`, { encoding: "utf-8" }).length === 0;
}

// Actually need to check differently
function sessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t "${name}"`, { encoding: "utf-8", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── spawn background task ───────────────────────────────────────────────────

function spawnBgTask(command: string, cwd: string, timeout: number): BgTask {
  const id = taskId();
  const logFile = join(tmpdir(), `pi-bg-${id}.log`);
  const startTime = Date.now();

  // Build command that logs output and signals completion
  const wrappedCmd = [
    `cd "${cwd}"`,
    `{`,
    `  ${command}`,
    `} > "${logFile}" 2>&1`,
    `EXIT_CODE=$?`,
    `echo "EXIT_CODE=$EXIT_CODE" >> "${logFile}"`,
    `echo "DONE_AT=$(date +%s)" >> "${logFile}"`,
  ].join("\n");

  // Start in detached tmux session
  tmux(`new-session -d -s "${id}" "${wrappedCmd}"`);

  const task: BgTask = {
    id,
    cmd: command.length > 100 ? command.substring(0, 97) + "..." : command,
    tmuxSession: id,
    status: "running",
    startTime,
    logFile,
  };
  tasks.set(id, task);

  // Set the same timeout for killing the tmux session
  if (timeout > 0) {
    setTimeout(() => {
      if (task.status === "running") {
        tmux(`kill-session -t "${id}" 2>/dev/null`);
        task.status = "killed";
        task.endTime = Date.now();
      }
    }, timeout);
  }

  return task;
}

function getTaskOutput(task: BgTask): string {
  if (!existsSync(task.logFile)) return "(no output)";
  try {
    const content = readFileSync(task.logFile, "utf-8");
    // Parse exit code
    const exitMatch = content.match(/EXIT_CODE=(\d+)/);
    if (exitMatch) {
      task.exitCode = parseInt(exitMatch[1], 10);
      task.status = task.exitCode === 0 ? "done" : "error";
    }
    const doneMatch = content.match(/DONE_AT=(\d+)/);
    if (doneMatch) {
      task.endTime = parseInt(doneMatch[1], 10) * 1000;
    }
    return content;
  } catch {
    return "(cannot read output)";
  }
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── CORE: tool_call interceptor (CODE-ENFORCED) ──────────────────────
  pi.on("tool_call", async (event, ctx) => {
    // Intercept bash with timeout >300s
    if (event.toolName === "bash" && (event.input as any)?.timeout) {
      const timeout = (event.input as any).timeout;
      if (timeout > 300_000) {
        const cmd = (event.input as any).command || "";

        // Don't auto-background remote SSH commands — ssh extension handles those
        if (/\b(?:sshpass|ssh|scp|sftp|rsync)\b.*\S+@\S+/.test(cmd)) {
          return {
            block: true,
            reason: "Remote SSH over bg is not allowed. Use ssh_exec(host, command) for remote execution. " +
              "If the command is long-running, use a shorter ssh_exec call to trigger the remote work, " +
              "then ssh_exec can run it via tmux/nohup on the remote server directly.",
          };
        }

        const task = spawnBgTask(cmd, ctx.cwd, timeout);

        ctx.ui.notify(
          `Moved to background: ${task.id} (${(timeout / 1000).toFixed(0)}s timeout). Use /jobs to check.`,
          "info"
        );

        // Return immediately — the command is running in background
        return {
          block: true,
          reason: `Moved to background (tmux session ${task.id}). ` +
            `Command: ${cmd.substring(0, 80)}... ` +
            `Check /jobs for progress, /fg ${task.id} for output when done.`,
        };
      }
    }

    // Intercept subagent_spawn for tasks that look long-running
    if (event.toolName === "subagent_spawn") {
      const taskDesc = (event.input as any)?.task || "";
      const longKeywords = [
        "train", "download", "build", "compile", "deploy",
        "benchmark", "migrate", "import", "export", "scrape",
        "refactor entire", "rewrite all", "convert all",
      ];
      const looksLong = longKeywords.some((kw) => taskDesc.toLowerCase().includes(kw));

      if (looksLong) {
        ctx.ui.notify(
          `Task looks long-running: "${taskDesc.substring(0, 60)}". Consider /bg instead for background execution.`,
          "warning"
        );
        // Don't block — subagent needs review, so we can't fully automate
      }
    }
  });

  // ── /bg command: manual background start ────────────────────────────
  pi.registerCommand("bg", {
    description: "Start a command in background (tmux-managed)",
    handler: async (args, ctx) => {
      const cmd = args?.trim();
      if (!cmd) {
        // Show status
        showStatusWidget(ctx);
        return;
      }

      const task = spawnBgTask(cmd, ctx.cwd, 3_600_000); // Default 1h timeout
      ctx.ui.notify(`Background task ${task.id} started (tmux). /jobs to check, /attach ${task.id} to view live.`, "info");
      pollForCompletion(pi, ctx, task);
    },
  });

  // ── /jobs command ────────────────────────────────────────────────────
  pi.registerCommand("jobs", {
    description: "List background tasks",
    handler: async (_args, ctx) => {
      showStatusWidget(ctx);
    },
  });

  // ── /fg command: view completed task output ──────────────────────────
  pi.registerCommand("fg", {
    description: "View background task output",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) {
        // Show most recently completed
        let latest: BgTask | undefined;
        for (const t of tasks.values()) {
          if (t.status !== "running" && (!latest || (t.endTime || 0) > (latest.endTime || 0))) {
            latest = t;
          }
        }
        if (!latest) {
          // Show all running tasks
          showStatusWidget(ctx);
          return;
        }
        showTaskOutput(latest, ctx);
        return;
      }

      const task = tasks.get(id);
      if (!task) {
        ctx.ui.notify(`Task ${id} not found.`, "error");
        return;
      }
      showTaskOutput(task, ctx);
    },
  });

  // ── /attach command: attach to live tmux session ─────────────────────
  pi.registerCommand("attach", {
    description: "Attach to a running background task's tmux session",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) {
        ctx.ui.notify("Usage: /attach <task-id>", "warning");
        return;
      }

      const task = tasks.get(id);
      if (!task) {
        ctx.ui.notify(`Task ${id} not found.`, "error");
        return;
      }

      if (task.status !== "running" || !sessionExists(task.tmuxSession)) {
        // Session ended — show output instead
        task.status = task.status === "running" ? "done" : task.status;
        showTaskOutput(task, ctx);
        return;
      }

      ctx.ui.notify(`Attaching to ${id}... (Ctrl+B D to detach)`, "info");

      // Spawn an interactive tmux attach
      const proc = spawn("tmux", ["attach-session", "-t", task.tmuxSession], {
        stdio: "inherit",
        cwd: ctx.cwd,
      });

      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
      });

      // After detaching, check if still running
      if (!sessionExists(task.tmuxSession)) {
        task.status = "done";
        task.endTime = Date.now();
        ctx.ui.notify(`Task ${id} completed during attach. /fg ${id} to see output.`, "info");
      }
    },
  });

  // ── /kill command ────────────────────────────────────────────────────
  pi.registerCommand("kill-bg", {
    description: "Kill a background task",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) {
        ctx.ui.notify("Usage: /kill-bg <task-id>", "warning");
        return;
      }

      const task = tasks.get(id);
      if (!task) {
        ctx.ui.notify(`Task ${id} not found.`, "error");
        return;
      }

      tmux(`kill-session -t "${task.tmuxSession}" 2>/dev/null`);
      task.status = "killed";
      task.endTime = Date.now();
      cleanupTask(task);
      ctx.ui.notify(`Task ${id} killed.`, "info");
    },
  });

  // ── bg_spawn tool (AI can use) ──────────────────────────────────────
  pi.registerTool({
    name: "bg_spawn",
    label: "Background Task",
    description:
      "Start a task in background via tmux. The task runs while the user continues chatting. " +
      "Use /jobs to check status, /fg to view results, /attach to watch live.",
    parameters: Type.Object({
      task: Type.String({ description: "Command or task to run in background" }),
      model: Type.Optional(Type.String({ description: "Model override (not applicable for bash commands)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task = spawnBgTask(params.task, ctx.cwd, 3_600_000);
      pollForCompletion(pi, ctx, task);
      return {
        content: [{
          type: "text",
          text: [
            `Background task started.`,
            `ID: ${task.id}`,
            `Tmux: ${task.tmuxSession}`,
            ``,
            `Check: /jobs  |  View: /fg ${task.id}  |  Live: /attach ${task.id}  |  Kill: /kill-bg ${task.id}`,
          ].join("\n"),
        }],
        details: { taskId: task.id },
      };
    },
  });

  // ── bg_status tool ──────────────────────────────────────────────────
  pi.registerTool({
    name: "bg_status",
    label: "Background Status",
    description: "Check the status of all background tasks.",
    parameters: Type.Object({}),
    async execute() {
      if (tasks.size === 0) {
        return { content: [{ type: "text", text: "No background tasks." }], details: {} };
      }
      const lines = ["Background tasks:"];
      for (const [id, t] of tasks) {
        const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
        const icon = t.status === "done" ? "✅" : t.status === "running" ? "🔄" : "❌";
        lines.push(`  ${icon} ${id}: ${t.cmd.substring(0, 60)} (${elapsed.toFixed(0)}s)`);
      }
      lines.push("");
      lines.push("Commands: /jobs list  /fg view output  /attach watch live  /kill-bg stop");
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── session_shutdown cleanup ────────────────────────────────────────
  pi.on("session_shutdown", () => {
    for (const [id, task] of tasks) {
      tmux(`kill-session -t "${task.tmuxSession}" 2>/dev/null`);
      cleanupTask(task);
    }
    tasks.clear();
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function showStatusWidget(ctx: any): void {
  if (tasks.size === 0) {
    ctx.ui.setWidget("bg-status", ["No background tasks. Use /bg <command> to start one."]);
    return;
  }

  const lines = ["┌─ Background Tasks ───────────────────────────"];
  for (const [id, t] of tasks) {
    const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
    const line = t.status === "running"
      ? `│ 🔄 ${id}: ${t.cmd.substring(0, 45)} (${elapsed.toFixed(0)}s)`
      : `│ ${t.status === "done" ? "✅" : "❌"} ${id}: ${t.cmd.substring(0, 45)} (${elapsed.toFixed(0)}s)`;
    lines.push(line);
  }
  lines.push("├──────────────────────────────────────────────");
  lines.push("│ /fg <id> view  /attach <id> live  /kill-bg <id> stop");
  lines.push("└──────────────────────────────────────────────");

  ctx.ui.setWidget("bg-status", lines);
}

function showTaskOutput(task: BgTask, ctx: any): void {
  const output = getTaskOutput(task);
  const elapsed = ((task.endTime || Date.now()) - task.startTime) / 1000;

  const lines = [
    `┌─ ${task.id} ──────────────────────────────────`,
    `│ Command: ${task.cmd}`,
    `│ Status: ${task.status} (exit: ${task.exitCode ?? "?"})`,
    `│ Time: ${elapsed.toFixed(0)}s`,
    `├──────────────────────────────────────────────`,
  ];

  // Add output, truncate per line but don't cut content
  const outLines = output.split("\n");
  const maxShow = 50;
  for (let i = 0; i < Math.min(outLines.length, maxShow); i++) {
    const l = outLines[i].substring(0, 80);
    lines.push(`│ ${l}`);
  }
  if (outLines.length > maxShow) {
    lines.push(`│ ... (${outLines.length - maxShow} more lines)`);
  }
  lines.push("└──────────────────────────────────────────────");

  ctx.ui.setWidget("bg-output-" + task.id, lines);
}

function cleanupTask(task: BgTask): void {
  try {
    if (existsSync(task.logFile)) unlinkSync(task.logFile);
  } catch { /* ok */ }
}

function pollForCompletion(pi: ExtensionAPI, ctx: any, task: BgTask): void {
  const check = () => {
    if (!tasks.has(task.id)) return;
    if (!sessionExists(task.tmuxSession)) {
      // Session ended
      task.status = "done";
      task.endTime = Date.now();
      const output = getTaskOutput(task);
      ctx.ui.notify(`Background task ${task.id} completed. /fg ${task.id} to see output.`, "info");

      // If user is idle, show the result
      if (ctx.isIdle?.()) {
        ctx.ui.setWidget("bg-complete-" + task.id, [
          `┌─ Completed: ${task.id} ──────────────────────`,
          `│ ${task.cmd}`,
          `├──────────────────────────────────────────────`,
          ...output.split("\n").slice(0, 10).map((l: string) => `│ ${l.substring(0, 70)}`),
          `│ /fg ${task.id} for full output`,
          `└──────────────────────────────────────────────`,
        ]);
      }
      return;
    }

    // Still running, poll again
    const elapsed = (Date.now() - task.startTime) / 1000;
    ctx.ui.setStatus(task.id, `🔄 bg:${task.id} (${elapsed.toFixed(0)}s)`);

    setTimeout(check, 5000);
  };

  setTimeout(check, 3000);
}
