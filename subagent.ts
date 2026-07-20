/**
 * Sub-agent extension — Git worktree-based parallel delegation.
 *
 * Every sub-agent gets its own git worktree (isolated filesystem).
 * Sub-agents commit their work; the main agent reviews diffs, merges, or rejects.
 * If the project has no git repo, one is created automatically — no file locks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── types ───────────────────────────────────────────────────────────────────

interface SubAgent {
  id: string;
  branch: string;
  worktreePath: string;
  task: string;
  status: "running" | "done" | "error" | "cancelled" | "merged" | "rejected";
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  proc?: ChildProcess;
  model?: string;
  tools?: string[];
  commitHash?: string;
}

const subAgents = new Map<string, SubAgent>();

function shortId(): string {
  return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function branchName(id: string): string {
  return `pi/subagent/${id}`;
}

// ── git helpers ─────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  const { execSync } = require("child_process");
  return execSync(["git", ...args].join(" "), {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
}

function gitQuiet(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch (e: any) {
    return e.stderr || e.message || "";
  }
}

/** Ensure project has a git repo. Force-init if needed. */
function ensureGitRepo(projectRoot: string): string {
  const gitDir = join(projectRoot, ".git");
  if (existsSync(gitDir)) {
    // Verify it's usable
    try {
      git(["rev-parse", "--git-dir"], projectRoot);
      return projectRoot;
    } catch {
      // .git exists but corrupted — unlikely but handle
    }
  }

  // Force init
  git(["init"], projectRoot);
  // Create initial commit so worktree add works
  try {
    git(["add", "-A"], projectRoot);
    git(["commit", "-m", "pi: initial snapshot (auto-created for sub-agent tracking)", "--allow-empty"], projectRoot);
  } catch {
    git(["commit", "-m", "pi: initial snapshot", "--allow-empty"], projectRoot);
  }

  return projectRoot;
}

/** Create a worktree + branch for a sub-agent. Returns the worktree path. */
function createWorktree(projectRoot: string, id: string): string {
  const branch = branchName(id);
  const wtDir = join(projectRoot, ".pi", "subagent", id);

  // Ensure .pi/subagent directory exists
  mkdirSync(join(projectRoot, ".pi", "subagent"), { recursive: true });

  // Remove stale worktree if exists
  try { git(["worktree", "remove", "--force", wtDir], projectRoot); } catch { /* ok */ }
  try { git(["branch", "-D", branch], projectRoot); } catch { /* ok */ }

  // Create branch from HEAD
  git(["branch", branch, "HEAD"], projectRoot);

  // Create worktree
  git(["worktree", "add", wtDir, branch], projectRoot);

  return wtDir;
}

/** Get diff between a sub-agent branch and the branch it was forked from */
function getDiff(projectRoot: string, id: string): string {
  const branch = branchName(id);
  try {
    // Find the parent commit (where the branch diverged)
    const mergeBase = git(["merge-base", "HEAD", branch], projectRoot).trim();
    const diff = git(["diff", mergeBase, branch], projectRoot);
    const log = git(["log", "--oneline", `${mergeBase}..${branch}`], projectRoot);
    return `--- Commits ---\n${log}\n\n--- Diff ---\n${diff}`;
  } catch (e: any) {
    return `Unable to get diff: ${e.stderr || e.message}`;
  }
}

/** Commit changes in a worktree */
function commitWorktree(worktreePath: string, id: string, task: string): string {
  try {
    git(["add", "-A"], worktreePath);
    const msg = `subagent ${id}: ${task.substring(0, 80)}`;
    git(["commit", "-m", msg, "--allow-empty"], worktreePath);
    const hash = git(["rev-parse", "--short", "HEAD"], worktreePath).trim();
    return hash;
  } catch (e: any) {
    return "";
  }
}

/** Clean up worktree and optionally the branch */
function cleanupWorktree(projectRoot: string, id: string, deleteBranch: boolean): void {
  const wtDir = join(projectRoot, ".pi", "subagent", id);
  const branch = branchName(id);
  try { git(["worktree", "remove", "--force", wtDir], projectRoot); } catch { /* ok */ }
  if (deleteBranch) {
    try { git(["branch", "-D", branch], projectRoot); } catch { /* ok */ }
  }
}

// ── spawn sub-agent ─────────────────────────────────────────────────────────

function spawnSubAgent(
  task: string,
  projectRoot: string,
  options?: {
    model?: string;
    tools?: string[];
    systemPrompt?: string;
  }
): { id: string; promise: Promise<string> } {
  const id = shortId();
  const startTime = Date.now();

  // Ensure git repo and create worktree
  const root = ensureGitRepo(projectRoot);
  let worktreePath: string;
  try {
    worktreePath = createWorktree(root, id);
  } catch (e: any) {
    // Fallback: if worktree creation fails, return error immediately
    const errMsg = `Failed to create worktree: ${e.message}`;
    return {
      id,
      promise: Promise.resolve(`[Sub-agent error] ${errMsg}`),
    };
  }

  const agent: SubAgent = {
    id,
    branch: branchName(id),
    worktreePath,
    task,
    status: "running",
    startTime,
    model: options?.model,
    tools: options?.tools,
  };
  subAgents.set(id, agent);

  const promise = new Promise<string>((resolve) => {
    const args: string[] = [
      "-p",
      "--no-context-files",
      "--no-session",
      "--cwd", worktreePath,
    ];
    if (options?.model) args.push("--model", options.model);
    if (options?.tools) args.push("--tools", options.tools.join(","));
    if (options?.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    args.push(task);

    const proc = spawn("pi", args, {
      cwd: worktreePath,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    agent.proc = proc;

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      agent.endTime = Date.now();
      if (agent.status === "cancelled") return;

      agent.status = code === 0 ? "done" : "error";

      if (code === 0) {
        agent.result = stdout.trim();
        // Auto-commit changes made by the sub-agent
        agent.commitHash = commitWorktree(worktreePath, id, task);
        resolve(stdout.trim());
      } else {
        agent.error = stderr.trim() || `exit code ${code}`;
        resolve(`[Sub-agent error (${code})] ${agent.error}\n\nOutput:\n${stdout.trim().substring(0, 3000)}`);
      }
    });

    proc.on("error", (err) => {
      agent.status = "error";
      agent.error = err.message;
      resolve(`[Sub-agent spawn error] ${err.message}`);
    });

    // 10 minute timeout
    setTimeout(() => {
      if (agent.status === "running") {
        proc.kill();
        agent.status = "error";
        agent.error = "timeout (10 min)";
        resolve(`[Sub-agent timeout]\n\nPartial:\n${stdout.trim().substring(0, 2000)}`);
      }
    }, 600_000);
  });

  return { id, promise };
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /subagent command ──────────────────────────────────────────────────
  pi.registerCommand("subagent", {
    description: "Sub-agent management with git worktree isolation",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0];
      const rest = parts.slice(1).join(" ");

      switch (subcmd) {
        case "spawn": {
          if (!rest) { ctx.ui.notify("Usage: /subagent spawn <task>", "warning"); return; }
          const { id } = spawnSubAgent(rest, ctx.cwd);
          ctx.ui.notify(`Sub-agent ${id} spawned (worktree: .pi/subagent/${id})`, "info");
          return;
        }
        case "list": {
          if (subAgents.size === 0) { ctx.ui.notify("No sub-agents running.", "info"); return; }
          const lines = ["Running sub-agents:"];
          for (const [id, a] of subAgents) {
            lines.push(`  ${id}: [${a.status}] ${a.task.substring(0, 50)}`);
          }
          ctx.ui.setWidget("sa-list", lines.map((l) => `│ ${l}`));
          return;
        }
        case "cancel": {
          if (!rest) { ctx.ui.notify("Usage: /subagent cancel <id>", "warning"); return; }
          const ag = subAgents.get(rest);
          if (!ag) { ctx.ui.notify(`No sub-agent: ${rest}`, "error"); return; }
          ag.status = "cancelled";
          ag.proc?.kill();
          cleanupWorktree(ctx.cwd, rest, true);
          subAgents.delete(rest);
          ctx.ui.notify(`Sub-agent ${rest} cancelled and cleaned up.`, "info");
          return;
        }
        case "status": {
          ctx.ui.setWidget("sa-status", [
            `Active sub-agents: ${subAgents.size}`,
            `Worktrees: .pi/subagent/`,
            ...([...subAgents.entries()].map(([id, a]) =>
              `  ${id} [${a.status}] ${a.branch}`
            )),
          ]);
          return;
        }
        default: {
          ctx.ui.setWidget("subagent-help", [
            "┌─ /subagent (git worktree) ─────────────────",
            "│ /subagent spawn <task>   Spawn a sub-agent",
            "│ /subagent list           List running sub-agents",
            "│ /subagent cancel <id>    Cancel + cleanup",
            "│ /subagent status         Show worktree overview",
            "│",
            "│ AI tools:",
            "│   subagent_spawn     — spawn one",
            "│   subagent_wait      — wait for result",
            "│   subagent_review    — inspect git diff",
            "│   subagent_merge     — merge branch → main",
            "│   subagent_reject    — delete branch + worktree",
            "│   subagent_parallel  — fan-out N agents",
            "│   subagent_chain     — sequential pipeline",
            "└───────────────────────────────────────────",
          ]);
        }
      }
    },
  });

  // ── subagent_spawn ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Sub-agent",
    description:
      "Spawn a sub-agent in an isolated git worktree. " +
      "The sub-agent works independently; when done, its changes are committed to a branch. " +
      "Use subagent_review to inspect the diff, subagent_merge to accept, or subagent_reject to discard. " +
      "If the project has no git repo, one is created automatically.",
    promptSnippet: "Spawn a sub-agent to handle a self-contained task in an isolated git worktree.",
    promptGuidelines: [
      "Use subagent_spawn when a task is self-contained and can be done in parallel with other work.",
      "Use subagent_spawn with model='gpt-4o-mini' for cheap, simple tasks like searching or reading files.",
      "When a user asks for multiple independent changes, spawn a subagent for each one with subagent_parallel.",
      "Always review sub-agent output with subagent_review before merging — never merge blindly.",
      "After spawning, use subagent_wait to collect the result, then decide: subagent_merge or subagent_reject.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task description for the sub-agent" }),
      model: Type.Optional(Type.String({ description: "Model override (e.g. 'gpt-4o-mini' for cheap tasks)" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { id, promise } = spawnSubAgent(params.task, ctx.cwd, {
        model: params.model,
        tools: params.tools ? params.tools.split(",").map((t: string) => t.trim()) : undefined,
        systemPrompt: params.systemPrompt,
      });

      // Fire and forget — return immediately
      promise.then(() => {
        // Completion will be picked up by subagent_wait
      });

      return {
        content: [{
          type: "text",
          text: [
            `Sub-agent spawned. ID: ${id}`,
            `Branch: ${branchName(id)}`,
            `Worktree: .pi/subagent/${id}`,
            `Task: ${params.task}`,
            `Model: ${params.model || "default"}`,
            "",
            `Use subagent_wait("${id}") to collect the result.`,
            `Use subagent_review("${id}") to inspect the diff.`,
            `Use subagent_merge("${id}") to accept changes.`,
            `Use subagent_reject("${id}") to discard.`,
          ].join("\n"),
        }],
        details: { subagentId: id },
      };
    },
  });

  // ── subagent_wait ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Sub-agent",
    description: "Wait for a sub-agent to complete. Returns the result and indicates whether changes were committed.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Max wait ms (default: 600000 = 10 min)" })),
    }),
    async execute(_id, params, _signal) {
      const ag = subAgents.get(params.id);
      if (!ag) {
        return {
          content: [{ type: "text", text: `Sub-agent ${params.id} not found. It may have already completed or never existed.` }],
          details: {},
          isError: true,
        };
      }

      const deadline = Date.now() + (params.timeoutMs || 600_000);
      while (ag.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }

      if (ag.status === "running") {
        return {
          content: [{ type: "text", text: `Sub-agent ${params.id} still running. Check again or cancel with subagent_cancel.` }],
          details: { status: "running" },
        };
      }

      const elapsed = ((ag.endTime || Date.now()) - ag.startTime) / 1000;

      return {
        content: [{
          type: "text",
          text: [
            `=== Sub-agent ${params.id} ===`,
            `Status: ${ag.status}`,
            `Elapsed: ${elapsed.toFixed(1)}s`,
            `Branch: ${ag.branch}`,
            `Commit: ${ag.commitHash || "(none)"}`,
            `Worktree: ${ag.worktreePath}`,
            "",
            ag.result || ag.error || "(empty)",
            "",
            ag.commitHash
              ? `Changes committed. Use subagent_review("${params.id}") to inspect, then subagent_merge or subagent_reject.`
              : "No changes committed.",
          ].join("\n"),
        }],
        details: {
          subagentId: params.id,
          status: ag.status,
          elapsed,
          branch: ag.branch,
          commitHash: ag.commitHash,
        },
      };
    },
  });

  // ── subagent_review (NEW) ──────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_review",
    label: "Review Sub-agent Changes",
    description:
      "Inspect the git diff and commit log of a completed sub-agent. " +
      "Use this to decide whether to merge or reject the sub-agent's work.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ag = subAgents.get(params.id);
      if (ag && ag.status === "running") {
        return {
          content: [{ type: "text", text: `Sub-agent ${params.id} still running. Wait for completion first.` }],
          details: {},
        };
      }

      const diff = getDiff(ctx.cwd, params.id);

      return {
        content: [{
          type: "text",
          text: [
            `=== Review: Sub-agent ${params.id} ===`,
            `Branch: ${branchName(params.id)}`,
            `Task: ${ag?.task || "(already cleaned up)"}`,
            "",
            diff || "(no changes or agent already cleaned up)",
            "",
            "---",
            `To accept:  subagent_merge("${params.id}")`,
            `To reject:  subagent_reject("${params.id}")`,
          ].join("\n"),
        }],
        details: { subagentId: params.id },
      };
    },
  });

  // ── subagent_merge (NEW) ───────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_merge",
    label: "Merge Sub-agent",
    description:
      "Merge a sub-agent's branch into the main branch. " +
      "If there are merge conflicts, they are reported so the main agent can resolve them.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const branch = branchName(params.id);
      const ag = subAgents.get(params.id);

      // Try merge
      try {
        // Check for conflicts first
        const mergeCheck = gitQuiet(["merge", "--no-commit", "--no-ff", branch], ctx.cwd);
        const hasConflicts = mergeCheck.includes("CONFLICT");

        if (hasConflicts) {
          // Abort the merge attempt so user can inspect
          gitQuiet(["merge", "--abort"], ctx.cwd);

          // Show conflicting files
          const conflictFiles = gitQuiet(["diff", "--name-only", "--diff-filter=U"], ctx.cwd);

          return {
            content: [{
              type: "text",
              text: [
                `⚠ Merge conflicts detected for sub-agent ${params.id}`,
                `Branch: ${branch}`,
                "",
                "Conflicting files:",
                conflictFiles || "(check manually)",
                "",
                "The merge was aborted. You need to resolve conflicts manually:",
                `  git merge ${branch}`,
                "  # resolve conflicts",
                "  git add -A && git commit",
              ].join("\n"),
            }],
            details: { hasConflicts: true, branch },
          };
        }

        // Clean merge — commit it
        git(["commit", "-m", `pi: merge subagent ${params.id}: ${ag?.task?.substring(0, 60) || "delegated task"}`, "--no-edit"], ctx.cwd);

        // Update agent status
        if (ag) ag.status = "merged";

        // Clean up worktree (keep branch for history)
        cleanupWorktree(ctx.cwd, params.id, false);
        subAgents.delete(params.id);

        return {
          content: [{
            type: "text",
            text: [
              `✅ Sub-agent ${params.id} merged successfully.`,
              `Branch: ${branch}`,
              ag?.commitHash ? `Commits: ${ag.commitHash}` : "",
              "",
              "Worktree cleaned up. Branch retained for history.",
            ].join("\n"),
          }],
          details: { merged: true, branch },
        };
      } catch (e: any) {
        // Abort any partial merge
        try { git(["merge", "--abort"], ctx.cwd); } catch { /* ok */ }

        return {
          content: [{
            type: "text",
            text: `Merge failed for ${params.id}: ${e.stderr || e.message}`,
          }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── subagent_reject (NEW) ──────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_reject",
    label: "Reject Sub-agent",
    description: "Reject a sub-agent's work: delete its branch and worktree.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ag = subAgents.get(params.id);
      if (ag) ag.status = "rejected";

      cleanupWorktree(ctx.cwd, params.id, true);
      subAgents.delete(params.id);

      return {
        content: [{
          type: "text",
          text: [
            `🗑 Sub-agent ${params.id} rejected.`,
            `Branch ${branchName(params.id)} deleted.`,
            `Worktree removed.`,
          ].join("\n"),
        }],
        details: { rejected: true },
      };
    },
  });

  // ── subagent_parallel ──────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_parallel",
    label: "Parallel Sub-agents",
    description:
      "Spawn multiple sub-agents in parallel git worktrees. " +
      "All work independently and commit to their own branches. " +
      "Returns all results. Review each with subagent_review before merging.",
    promptSnippet: "Spawn multiple sub-agents in parallel for independent tasks — fan-out, then review.",
    promptGuidelines: [
      "Use subagent_parallel when the user asks for 3+ independent changes or searches.",
      "Prefer subagent_parallel over sequential execution for independent tasks — it saves wall-clock time.",
      "After all parallel sub-agents complete, review each result with subagent_review before merging.",
      "For tasks that depend on each other, use subagent_chain instead.",
    ],
    parameters: Type.Object({
      tasks: Type.String({ description: "JSON array of task strings" }),
      model: Type.Optional(Type.String({ description: "Model override" })),
      maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent (default: 5)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let tasks: string[];
      try { tasks = JSON.parse(params.tasks); } catch {
        tasks = params.tasks.split("\n").filter((t: string) => t.trim());
      }
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks provided." }], details: {}, isError: true };
      }

      const maxCon = params.maxConcurrency || 5;
      const results: { task: string; id: string; result: string; status: string; elapsed: number; commitHash?: string }[] = [];

      for (let i = 0; i < tasks.length; i += maxCon) {
        const batch = tasks.slice(i, i + maxCon);
        const batchPromises = batch.map((task) => {
          const { id, promise } = spawnSubAgent(task, ctx.cwd, { model: params.model });
          return promise.then((result) => {
            const ag = subAgents.get(id);
            return {
              task,
              id,
              result,
              status: ag?.status || "done",
              elapsed: ((ag?.endTime || Date.now()) - (ag?.startTime || Date.now())) / 1000,
              commitHash: ag?.commitHash,
            };
          });
        });
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        for (const r of batchResults) subAgents.delete(r.id);
      }

      const summary = [
        `=== ${results.length} sub-agents completed ===`,
        ...results.map((r, i) =>
          `[${i + 1}] ${r.status === "done" ? "✓" : "✗"} (${r.elapsed.toFixed(1)}s) ${r.id}: ${r.task.substring(0, 50)}`
        ),
        "",
        "Review each with subagent_review(id) before merging.",
        "",
        ...results.map((r, i) =>
          `=== [${i + 1}] ${r.id}: ${r.task.substring(0, 40)} ===\n` +
          `Commit: ${r.commitHash || "(none)"}\n` +
          `${r.result.substring(0, 2000)}\n`
        ),
      ];

      return { content: [{ type: "text", text: summary.join("\n") }], details: { count: results.length } };
    },
  });

  // ── subagent_chain ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_chain",
    label: "Chain Sub-agents",
    description:
      "Run sub-agents sequentially, each in its own worktree. " +
      "Each sub-agent receives the previous agent's output as context.",
    promptSnippet: "Run sub-agents in sequence — each one builds on the previous output.",
    promptGuidelines: [
      "Use subagent_chain for multi-step pipelines: research → summarize, generate → review → refine.",
      "Each step receives the previous step's output as context automatically.",
      "Use subagent_chain when later steps depend on the output of earlier steps.",
    ],
    parameters: Type.Object({
      tasks: Type.String({ description: "JSON array of task strings, executed in order" }),
      model: Type.Optional(Type.String({ description: "Model override" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let tasks: string[];
      try { tasks = JSON.parse(params.tasks); } catch {
        tasks = params.tasks.split("\n").filter((t: string) => t.trim());
      }
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks provided." }], details: {}, isError: true };
      }

      let context = "";
      const results: { task: string; id: string; result: string; commitHash?: string }[] = [];

      for (const task of tasks) {
        const fullTask = context
          ? `${task}\n\n--- Context from previous step ---\n${context.substring(0, 3000)}\n---`
          : task;
        const { id, promise } = spawnSubAgent(fullTask, ctx.cwd, { model: params.model });
        const result = await promise;
        const ag = subAgents.get(id);
        context = result;
        results.push({ task, id, result, commitHash: ag?.commitHash });
        subAgents.delete(id);
      }

      const summary = [
        `=== Chained ${tasks.length} sub-agents ===`,
        ...tasks.map((t, i) => `  [${i + 1}] ${t.substring(0, 60)}`),
        "",
        `=== Final Result ===`,
        results[results.length - 1]?.result || "(empty)",
        "",
        "All steps committed to their branches. Review and merge individually.",
      ];

      return { content: [{ type: "text", text: summary.join("\n") }], details: { steps: tasks.length } };
    },
  });

  // ── subagent_list / subagent_cancel ────────────────────────────────────
  pi.registerTool({
    name: "subagent_list",
    label: "List Sub-agents",
    description: "List all running sub-agents and their worktrees.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (subAgents.size === 0) {
        return { content: [{ type: "text", text: "No sub-agents running." }], details: {} };
      }
      const lines = ["Running sub-agents:"];
      for (const [id, a] of subAgents) {
        lines.push(`  ${id}: [${a.status}] branch=${a.branch} task="${a.task.substring(0, 50)}"`);
      }
      // Also list existing worktrees
      try {
        lines.push("\nGit worktrees:");
        lines.push(git(["worktree", "list"], ctx.cwd));
      } catch { /* ok */ }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Sub-agent",
    description: "Cancel a running sub-agent and clean up its worktree.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ag = subAgents.get(params.id);
      if (!ag) {
        return { content: [{ type: "text", text: `Sub-agent ${params.id} not found.` }], details: {}, isError: true };
      }
      ag.status = "cancelled";
      ag.proc?.kill();
      cleanupWorktree(ctx.cwd, params.id, true);
      subAgents.delete(params.id);
      return { content: [{ type: "text", text: `Sub-agent ${params.id} cancelled. Worktree and branch removed.` }], details: {} };
    },
  });

  // ── subagent_ensure_git (NEW) ──────────────────────────────────────────
  pi.registerTool({
    name: "subagent_ensure_git",
    label: "Ensure Git Repo",
    description: "Initialize a git repository in the project if one doesn't exist. Called automatically; rarely needed manually.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        ensureGitRepo(ctx.cwd);
        return { content: [{ type: "text", text: "Git repository is ready." }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── cleanup on shutdown ────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    for (const [id, ag] of subAgents) {
      ag.status = "cancelled";
      ag.proc?.kill();
    }
    // Don't auto-cleanup worktrees — they contain committed work that may be valuable
    subAgents.clear();
  });
}
