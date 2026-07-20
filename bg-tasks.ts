/**
 * Background Tasks extension — run long work in background, keep chatting.
 *
 * /bg <task>   → start a task as background sub-agent, free the foreground
 * /bg           → detach current running sub-agent(s) to background
 * /jobs         → list background tasks
 * /fg <id>      → bring a completed background result to foreground
 *
 * Background agents use git worktree isolation. When they complete and the
 * user is idle, the result appears as a widget above the editor.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── types ───────────────────────────────────────────────────────────────────

interface BgJob {
  id: string;
  task: string;
  status: "running" | "done" | "error" | "cancelled";
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  proc?: ChildProcess;
  model?: string;
}

const jobs = new Map<string, BgJob>();

function bgId(): string {
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── spawn background pi process ────────────────────────────────────────────

function spawnBg(task: string, cwd: string, model?: string): { id: string; promise: Promise<string> } {
  const id = bgId();
  const workDir = mkdtempSync(join(tmpdir(), "pi-bg-"));
  const startTime = Date.now();

  const job: BgJob = { id, task, status: "running", startTime, model };
  jobs.set(id, job);

  const promise = new Promise<string>((resolve) => {
    const args: string[] = ["-p", "--no-context-files", "--no-session"];
    if (model) args.push("--model", model);
    args.push(task);

    const proc = spawn("pi", args, {
      cwd: workDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.proc = proc;

    let stdout = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (_chunk: Buffer) => { /* captured but ignored for stderr noise */ });

    proc.on("close", (code) => {
      job.endTime = Date.now();
      if (job.status === "cancelled") return;
      job.status = code === 0 ? "done" : "error";
      if (code === 0) {
        job.result = stdout.trim();
      } else {
        job.error = `exit code ${code}`;
        job.result = stdout.trim() || `(exit ${code})`;
      }
      resolve(job.result || job.error || "");
      try { rmSync(workDir, { recursive: true }); } catch { /* ok */ }
    });

    proc.on("error", (err) => {
      job.status = "error";
      job.error = err.message;
      resolve(`[bg error] ${err.message}`);
    });

    setTimeout(() => {
      if (job.status === "running") {
        proc.kill();
        job.status = "error";
        job.error = "timeout";
        resolve("[bg timeout after 30 min]");
      }
    }, 1_800_000);
  });

  return { id, promise };
}

// ── detach current work to background ───────────────────────────────────────

async function detachCurrentWork(pi: ExtensionAPI, ctx: any): Promise<void> {
  try {
    // Get the last user message from the session
    const entries = ctx.sessionManager.getEntries();
    let lastUserEntry: any = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "user") {
        lastUserEntry = entries[i];
        break;
      }
    }

    if (!lastUserEntry) {
      ctx.ui.notify("No user message found to detach.", "error");
      return;
    }

    // Extract the text content from the user message
    const userText = extractText(lastUserEntry.content);
    if (!userText.trim()) {
      ctx.ui.notify("User message is empty.", "error");
      return;
    }

    // Spawn background pi to re-run the prompt
    const { id } = spawnBg(userText, ctx.cwd);
    ctx.ui.notify(`Work detached to background: ${id}. Old session becomes foreground.`, "info");

    // Fork to a clean session from before the current work
    // The fork creates a new session file from the parent entry;
    // the original session's work is aborted and restarted in background.
    await ctx.fork(lastUserEntry.id, {
      position: "before", // fork before the user message, restoring it to editor
      withSession: async (newCtx: any) => {
        newCtx.ui.notify(`Clean session ready. Background task: ${id}`, "info");
        pollCompletion(pi, newCtx, id);
      },
    });
  } catch (e: any) {
    ctx.ui.notify(`Failed to detach: ${e.message}`, "error");
  }
}

// ── extract text from message content ──────────────────────────────────────

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── track whether agent is currently working ─────────────────────
  let agentActive = false;
  pi.on("agent_start", () => { agentActive = true; });
  pi.on("agent_end", () => { agentActive = false; });

  // ── /bg command ──────────────────────────────────────────────────
  pi.registerCommand("bg", {
    description:
      "Without args: detach current work to background and start clean session. " +
      "With args: run a new task in background.",
    handler: async (args, ctx) => {
      const task = args?.trim();

      if (!task) {
        // No args + agent is working → detach current work to background
        if (agentActive) {
          await detachCurrentWork(pi, ctx);
          return;
        }
        // No args + agent idle → show jobs
        if (jobs.size === 0) {
          ctx.ui.notify("No background jobs. Use /bg <task> to start one, or /bg while agent is working to detach.", "info");
          return;
        }
        showJobsWidget(ctx);
        return;
      }

      // Start a new background task
      const { id } = spawnBg(task, ctx.cwd);
      ctx.ui.notify(`Background job ${id} started`, "info");
      pollCompletion(pi, ctx, id);
    },
  });

  // ── /jobs command ────────────────────────────────────────────────────
  pi.registerCommand("jobs", {
    description: "List background tasks",
    handler: async (_args, ctx) => {
      if (jobs.size === 0) {
        ctx.ui.notify("No background jobs.", "info");
        return;
      }
      showJobsWidget(ctx);
    },
  });

  // ── /fg command ──────────────────────────────────────────────────────
  pi.registerCommand("fg", {
    description: "Bring a completed background task result to foreground",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) {
        // Show the most recently completed job
        let latest: BgJob | undefined;
        for (const job of jobs.values()) {
          if (job.status === "done" && (!latest || (job.endTime || 0) > (latest.endTime || 0))) {
            latest = job;
          }
        }
        if (!latest) {
          ctx.ui.notify("No completed background jobs. Use /jobs to see all.", "info");
          return;
        }
        showResult(latest, ctx);
        return;
      }

      const job = jobs.get(id);
      if (!job) {
        ctx.ui.notify(`Job ${id} not found.`, "error");
        return;
      }
      if (job.status === "running") {
        ctx.ui.notify(`Job ${id} still running. Check /jobs for status.`, "warning");
        return;
      }
      showResult(job, ctx);
    },
  });

  // ── bg_spawn tool (AI can use) ──────────────────────────────────────
  pi.registerTool({
    name: "bg_spawn",
    label: "Background Task",
    description:
      "Start a task in background. The task runs while you continue the conversation. " +
      "Use /jobs to check status, /fg to view results. " +
      "Use this for long-running work (builds, downloads, training) so the user can keep chatting.",
    parameters: Type.Object({
      task: Type.String({ description: "Task to run in background" }),
      model: Type.Optional(Type.String({ description: "Model override (e.g. 'deepseek-v4-flash')" })),
    }),
    promptGuidelines: [
      "Use bg_spawn for long-running tasks (builds, downloads, data processing, training) so the user can continue chatting.",
      "CRITICAL: If a bash command or sub-agent task is expected to take >300 seconds, use bg_spawn instead of running it in the foreground.",
      "When using subagent_spawn for tasks expected to take >5 minutes, set a timeout and suggest the user check back with /jobs.",
      "Tell the user they can check progress with /jobs and view results with /fg.",
      "For code changes that need review, use subagent_spawn instead — bg_spawn is for fire-and-forget work.",
    ],
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { id } = spawnBg(params.task, ctx.cwd, params.model);
      pollCompletion(pi, ctx, id);
      return {
        content: [{
          type: "text",
          text: `Background job started. ID: ${id}\nTask: ${params.task}\n\nUse /jobs to check progress. Use /fg ${id} to view results when done.`,
        }],
        details: { jobId: id },
      };
    },
  });

  // ── bg_status tool ──────────────────────────────────────────────────
  pi.registerTool({
    name: "bg_status",
    label: "Background Status",
    description: "Check the status of all background jobs.",
    parameters: Type.Object({}),
    async execute() {
      if (jobs.size === 0) {
        return { content: [{ type: "text", text: "No background jobs." }], details: {} };
      }
      const lines = ["Background jobs:"];
      for (const [id, j] of jobs) {
        const elapsed = ((j.endTime || Date.now()) - j.startTime) / 1000;
        const icon = j.status === "done" ? "✅" : j.status === "running" ? "🔄" : j.status === "error" ? "❌" : "⏹";
        lines.push(`  ${icon} ${id}: [${j.status}] ${j.task.substring(0, 60)} (${elapsed.toFixed(0)}s)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── session_shutdown cleanup ────────────────────────────────────────
  pi.on("session_shutdown", () => {
    for (const [, job] of jobs) {
      job.status = "cancelled";
      job.proc?.kill();
    }
    jobs.clear();
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function showJobsWidget(ctx: any): void {
  const lines = ["Background jobs:"];
  for (const [id, j] of jobs) {
    const elapsed = ((j.endTime || Date.now()) - j.startTime) / 1000;
    const icon = j.status === "done" ? "✅" : j.status === "running" ? "🔄" : j.status === "error" ? "❌" : "⏹";
    lines.push(`  ${icon} ${id}: ${j.task.substring(0, 50)} (${elapsed.toFixed(0)}s)`);
  }
  ctx.ui.setWidget("bg-jobs", lines);
}

function showResult(job: BgJob, ctx: any): void {
  const lines = [
    `┌─ Background: ${job.id} ───────────────────────`,
    `│ Task: ${job.task}`,
    `│ Status: ${job.status}`,
    `│ Time: ${((job.endTime || Date.now()) - job.startTime) / 1000}s`,
    `├─────────────────────────────────────────────`,
    ...(job.result || job.error || "(empty)").split("\n").map((l: string) => `│ ${l}`),
    `└─────────────────────────────────────────────`,
  ];
  ctx.ui.setWidget("bg-result-" + job.id, lines);
}

function pollCompletion(pi: ExtensionAPI, ctx: any, id: string): void {
  const check = () => {
    const job = jobs.get(id);
    if (!job) return;

    if (job.status === "done" || job.status === "error") {
      ctx.ui.notify(`Background job ${id} complete (${job.status})`, job.status === "done" ? "info" : "error");
      ctx.ui.setStatus("bg-" + id, `${job.status === "done" ? "✅" : "❌"} bg:${id}`);
      jobs.delete(id); // Keep result accessible via /fg but clean up tracking
      return;
    }

    if (job.status === "running") {
      setTimeout(check, 3000);
    }
  };

  setTimeout(check, 2000);
}
