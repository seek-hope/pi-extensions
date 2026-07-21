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
  const escaped = args.map(a => `'${a.replace(/'/g, "'\\''")}'`);
  return execSync(["git", ...escaped].join(" "), {
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

// ── depth tracking ─────────────────────────────────────────────────────────

const MAX_DEPTH = 5;

function currentDepth(): number {
  const d = parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);
  return isNaN(d) ? 0 : d;
}

function projectRoot(cwd: string): string {
  return process.env.PI_SUBAGENT_ROOT || cwd;
}

// ── spawn sub-agent ─────────────────────────────────────────────────────────

function spawnSubAgent(
  task: string,
  cwd: string,
  options?: {
    model?: string;
    tools?: string[];
    systemPrompt?: string;
  }
): { id: string; promise: Promise<string> } {
  const depth = currentDepth();
  if (depth >= MAX_DEPTH) {
    const errMsg = `Sub-agent depth limit reached (depth=${depth}, max=${MAX_DEPTH}). Cannot spawn nested sub-agent.`;
    return {
      id: `sa-depth-limit-${Date.now()}`,
      promise: Promise.resolve(`[Sub-agent denied] ${errMsg}`),
    };
  }

  const id = shortId();
  const startTime = Date.now();

  // Use original project root (set by top-level pi), not worktree cwd
  const root = ensureGitRepo(projectRoot(cwd));
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
    ];
    if (options?.model) args.push("--model", options.model);
    if (options?.tools) {
      const toolsArg = Array.isArray(options.tools) ? options.tools.join(",") : options.tools;
      args.push("--tools", toolsArg);
    }
    if (options?.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    args.push(task);

    const proc = spawn("pi", args, {
      cwd: worktreePath,
      env: {
        ...process.env,
        PI_SUBAGENT_DEPTH: String(depth + 1),
        PI_SUBAGENT_ROOT: root,
      },
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

// ── refine summary helper ──────────────────────────────────────────────────

function buildRefineSummary(
  id: string,
  ag: SubAgent,
  iterations: { iter: number; reviewerResult: string; fixerResult: string; issuesFound: number; clean: boolean }[],
  passed: boolean
): string {
  const lines = [
    `┌─ Refine: Sub-agent ${id} ──────────────────────`,
    `│ Branch: ${ag.branch}`,
    `│ Iterations: ${iterations.length}`,
    `│ Result: ${passed ? "✅ ALL CLEAN" : "⚠ MAX ITERATIONS REACHED"}`,
    `│`,
  ];

  for (const it of iterations) {
    lines.push(`│ Iteration ${it.iter}:`);
    lines.push(`│   Reviewer found ${it.issuesFound} issue(s) → ${it.clean ? "CLEAN" : "FIXING"}`);
    if (!it.clean && it.fixerResult) {
      lines.push(`│   Fixer applied corrections`);
    }
  }

  if (passed) {
    lines.push(`│`);
    lines.push(`│ Ready to merge. Use subagent_merge("${id}").`);
  } else {
    const last = iterations[iterations.length - 1];
    lines.push(`│`);
    lines.push(`│ ${last.issuesFound} issue(s) remain after ${iterations.length} iterations.`);
    lines.push(`│ Manual review recommended before merge.`);
    lines.push(`│`);
    lines.push(`│ Last reviewer output:`);
    for (const l of last.reviewerResult.split("\n").slice(0, 20)) {
      lines.push(`│   ${l}`);
    }
  }

  lines.push(`└──────────────────────────────────────────────`);
  return lines.join("\n");
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
            "│   subagent_refine    — review→fix→re-review until clean",
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
      "Use subagent_spawn with model='deepseek-v4-flash' for cheap, simple tasks like searching or reading files.",
      "When a user asks for multiple independent changes, spawn a subagent for each one with subagent_parallel.",
      "Always review sub-agent output with subagent_review before merging — never merge blindly.",
      "After spawning (spawn, explore, plan), use subagent_wait to collect the result, then subagent_review/reject/merge.",
      "For exploration use subagent_explore (read-only, cheap). For planning use subagent_plan (design without implementing).",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task description for the sub-agent" }),
      model: Type.Optional(Type.String({ description: "Model override (e.g. 'deepseek-v4-flash' for cheap tasks)" })),
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
      "After all parallel sub-agents complete, use subagent_refine on each to auto-polish, then review with subagent_review before merging.",
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

  // ── subagent_explore (Claude Code Explore agent pattern) ───────────────
  pi.registerTool({
    name: "subagent_explore",
    label: "Explore Agent",
    description:
      "Spawn a read-only exploration sub-agent optimized for searching, reading, and analyzing code. " +
      "Uses deepseek-v4-flash by default for cost efficiency. " +
      "The agent has only read tools — it cannot modify files. " +
      "Use this for code discovery, dependency analysis, and research tasks.",
    promptSnippet: "Explore codebase with a read-only agent (v4-flash, cheap).",
    promptGuidelines: [
      "Use subagent_explore for code discovery, searching across multiple files, and understanding codebase structure.",
      "The explore agent is read-only — it's safe for any exploration task.",
      "Prefer subagent_explore over reading many files yourself — it keeps the main context clean.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Exploration task: what to search for or understand" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { id, promise } = spawnSubAgent(params.task, ctx.cwd, {
        model: "deepseek-v4-flash",
        tools: "read,bash,codegraph_search,codegraph_explore,serena_find_symbol,serena_search_pattern",
        systemPrompt: "You are an exploration agent. You can ONLY read and search — you CANNOT write, edit, or delete anything. Focus on finding information quickly and reporting it concisely.",
      });
      // Non-blocking: fire and collect later
      promise.then(() => {}).catch(() => {});
      return {
        content: [{
          type: "text",
          text: `Explore agent spawned. ID: ${id}\nTask: ${params.task}\n\nUse subagent_wait("${id}") to collect the result.`,
        }],
        details: { subagentId: id },
      };
    },
  });

  // ── subagent_plan (Claude Code / Codex Plan Mode pattern) ──────────────
  pi.registerTool({
    name: "subagent_plan",
    label: "Plan Agent",
    description:
      "Spawn a planning sub-agent that explores the codebase, designs an approach, and returns a step-by-step plan WITHOUT making any changes. " +
      "Use this before large refactors or complex implementations to get a reviewed plan first.",
    promptSnippet: "Design an implementation plan without modifying code.",
    promptGuidelines: [
      "Use subagent_plan before large changes: let it explore and design, then review the plan before implementing.",
      "The plan agent is read-only — it proposes a plan but does not execute it.",
      "After reviewing the plan, use subagent_spawn or subagent_parallel to execute each step.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Planning task: what should be designed" }),
      criteria: Type.Optional(Type.String({ description: "Specific requirements to consider in the plan" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const fullTask = params.criteria
        ? `${params.task}\n\nRequirements:\n${params.criteria}\n\nIMPORTANT: Do NOT modify any files. Produce a detailed step-by-step plan only.`
        : `${params.task}\n\nIMPORTANT: Do NOT modify any files. Produce a detailed step-by-step plan only.`;
      const { id, promise } = spawnSubAgent(fullTask, ctx.cwd, {
        model: "deepseek-v4-flash",
        tools: "read,bash,codegraph_search,codegraph_explore,serena_find_symbol,serena_search_pattern",
        systemPrompt: "You are a planning agent. You explore the codebase to understand the current state, then design a step-by-step implementation plan. You do NOT modify any files — you only READ and PLAN. Your output should be a clear, actionable plan.",
      });
      // Non-blocking: fire and collect later
      promise.then(() => {}).catch(() => {});
      return {
        content: [{
          type: "text",
          text: `Plan agent spawned. ID: ${id}\nTask: ${params.task}\n\nUse subagent_wait("${id}") to collect the plan.`,
        }],
        details: { subagentId: id },
      };
    },
  });

  // ── subagent_refine (NEW) ──────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_refine",
    label: "Refine Sub-agent",
    description:
      "Review a completed sub-agent's work, auto-fix issues, and re-review " +
      "in a loop until no problems remain or max iterations is reached. " +
      "The reviewer (deepseek-v4-pro) inspects the diff; the fixer (deepseek-v4-flash) " +
      "applies corrections on the same branch. Each iteration produces a new commit. " +
      "Returns the final diff and a summary of all fix iterations.",
    promptSnippet: "Review → fix → re-review loop until clean. Auto-iterate.",
    promptGuidelines: [
      "Use subagent_refine after subagent_wait returns done, to auto-polish the result before merging.",
      "The refine loop runs: reviewer inspects the diff → fixer corrects issues → re-review → repeat until clean.",
      "If maxIterations is reached and issues remain, the tool reports remaining issues for manual resolution.",
      "The reviewer uses v4-pro for deep analysis; the fixer uses v4-flash for fast corrections.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID to refine" }),
      criteria: Type.Optional(Type.String({ description: "Custom review criteria. Default: check for bugs, style, correctness, merge conflicts, and incomplete work." })),
      maxIterations: Type.Optional(Type.Number({ description: "Max review-fix iterations (default: 3, max: 5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ag = subAgents.get(params.id);
      if (!ag) {
        return { content: [{ type: "text", text: `Sub-agent ${params.id} not found.` }], details: {}, isError: true };
      }
      if (ag.status === "running") {
        return { content: [{ type: "text", text: `Sub-agent ${params.id} still running. Wait for completion first.` }], details: {} };
      }

      const maxIter = Math.min(params.maxIterations || 3, 5);
      const criteria = params.criteria ||
        "Check for: bugs, logic errors, security issues, style violations, incomplete implementation, " +
        "missing edge cases, merge conflicts markers, broken imports, and code that does not compile.";

      const iterations: { iter: number; reviewerResult: string; fixerResult: string; issuesFound: number; clean: boolean }[] = [];

      for (let i = 1; i <= maxIter; i++) {
        // Step 1: Review
        const reviewTask = [
          `Review the git diff of branch ${ag.branch}.`,
          `Review criteria: ${criteria}`,
          ``,
          `IMPORTANT: Respond in this exact format:`,
          `FOUND: <number of distinct issues found, 0 if none>`,
          `CLEAN: <true|false>  (true if no issues at all, the work is ready to merge)`,
          `ISSUES:`,
          `- <specific issue 1 with file path and line reference>`,
          `- <specific issue 2 with file path and line reference>`,
          `...`,
          ``,
          `If CLEAN is true, just write "CLEAN: true" and nothing else.`,
          `Be strict and thorough. Every issue must reference a concrete file and line.`,
        ].join("\n");

        const { promise: reviewPromise } = spawnSubAgent(reviewTask, ctx.cwd, {
          model: "deepseek-v4-pro",
        });
        const reviewerOutput = await reviewPromise;

        // Parse reviewer output
        const cleanMatch = reviewerOutput.match(/CLEAN:\s*(true|false)/i);
        const foundMatch = reviewerOutput.match(/FOUND:\s*(\d+)/i);
        const isClean = cleanMatch ? cleanMatch[1].toLowerCase() === "true" : false;
        const issuesCount = foundMatch ? parseInt(foundMatch[1], 10) : (isClean ? 0 : 1);

        iterations.push({
          iter: i,
          reviewerResult: reviewerOutput.substring(0, 3000),
          fixerResult: "",
          issuesFound: issuesCount,
          clean: isClean,
        });

        if (isClean || issuesCount === 0) {
          // Done!
          const summary = buildRefineSummary(params.id, ag, iterations, true);
          return { content: [{ type: "text", text: summary }], details: { iterations: i, clean: true } };
        }

        // Step 2: Fix
        const fixTask = [
          `You are fixing issues found during code review on branch ${ag.branch}.`,
          ``,
          `Review found ${issuesCount} issue(s):`,
          reviewerOutput.substring(0, 4000),
          ``,
          `Your task: Fix ALL the issues listed above.`,
          `- Work in the current directory (this is the worktree for branch ${ag.branch})`,
          `- Make concrete edits to the files`,
          `- After fixing, verify your changes are correct`,
          `- Do NOT commit — commits are handled automatically`,
          `- Be thorough: every issue listed above must be addressed`,
        ].join("\n");

        const { promise: fixPromise } = spawnSubAgent(fixTask, ctx.cwd, {
          model: "deepseek-v4-flash",
        });
        const fixerOutput = await fixPromise;

        // Commit the fixes
        const fixHash = commitWorktree(ag.worktreePath, params.id, `fix iteration ${i}: ${issuesCount} issue(s)`);
        iterations[iterations.length - 1].fixerResult = fixerOutput.substring(0, 2000) + (fixHash ? `\nCommit: ${fixHash}` : "");

        // Update agent commit hash
        ag.commitHash = fixHash || ag.commitHash;
      }

      // Max iterations reached
      const summary = buildRefineSummary(params.id, ag, iterations, false);
      return { content: [{ type: "text", text: summary }], details: { iterations: maxIter, clean: false, remainingIssues: true } };
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
