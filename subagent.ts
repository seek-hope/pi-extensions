/**
 * Sub-agent extension — Git worktree-based parallel delegation.
 *
 * Every sub-agent gets its own git worktree (isolated filesystem).
 * Sub-agents commit their work; the main agent reviews diffs, merges, or rejects.
 * If the project has no git repo, one is created automatically — no file locks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

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

/** Eviction age: terminal-state agents older than this are auto-removed from the map */
const EVICTION_AGE_MS = 10 * 60 * 1000; // 10 minutes

/** Remove stale terminal-state agents from the map to prevent unbounded growth */
function evictTerminalAgents(): void {
  const now = Date.now();
  for (const [id, ag] of subAgents) {
    if (["done", "error", "merged", "rejected"].includes(ag.status) && ag.endTime && (now - ag.endTime) > EVICTION_AGE_MS) {
      subAgents.delete(id);
    }
  }
}

function shortId(): string {
  return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Validate/sanitize a potentially user-provided sub-agent id for use in git branch names.
 *  Returns a safe version or null if the id is completely invalid. */
function safeId(raw: string): string | null {
  // Allow alphanumeric, dash, underscore. Replace anything else.
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  if (cleaned.length === 0 || cleaned.length > 80) return null;
  return cleaned;
}

// Read default/cheap model from pi settings
let _defaultModel: string | undefined;
let _cheapModel: string | undefined;
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8"));
  _defaultModel = cfg.defaultModel;
  // Derive a cheaper/faster model for analyze/exploration tasks:
  // 1. Use explicit cheapModel from settings if available
  // 2. Fall back to replacing "pro" → "flash" (common naming convention across providers)
  // 3. If neither produces a different model, cheapModel stays undefined (default model is used)
  if (cfg.cheapModel && typeof cfg.cheapModel === "string") {
    _cheapModel = cfg.cheapModel;
  } else if (_defaultModel) {
    const derived = _defaultModel.replace(/pro/i, "flash");
    _cheapModel = derived !== _defaultModel ? derived : _defaultModel; // fallback to default if no cheaper variant
  }
} catch (e: any) { /* settings file may not exist yet */ }

function branchName(id: string): string {
  const safe = safeId(id);
  if (!safe) {
    // Fallback: hash the raw id to produce a stable, safe branch component
    const hash = createHash("sha1").update(id).digest("hex").substring(0, 12);
    return `pi/subagent/fallback-${hash}`;
  }
  return `pi/subagent/${safe}`;
}

// ── Unified Review Loop Engine ─────────────────────────────────────────────

interface LoopResult {
  iterations: number;
  clean: boolean;
  summary: string;
}

/**
 * Core review→action→review loop shared by all three modes.
 * The reviewer runs as a sub-process (no worktree) for speed and to avoid stale-state issues.
 */
async function reviewLoop(
  ctxCwd: string,
  workCwd: string,
  buildReviewTask: (i: number) => string,
  runAction: (issuesCount: number, reviewerOutput: string, i: number) => Promise<string>,
  maxIterations = 20,
  commitPrefix = "loop"
): Promise<LoopResult> {
  const iterations: { iter: number; issuesFound: number; clean: boolean }[] = [];

  for (let i = 1; i <= maxIterations; i++) {
    evictTerminalAgents(); // periodic cleanup of stale agent records
    const reviewTask = buildReviewTask(i);
    // Reviewer runs directly (no worktree) — it only reads and reports
    const r = await runSubProcess(reviewTask, workCwd, _defaultModel, "read,bash");
    const reviewerOutput = r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : "");

    // Abort if reviewer crashed or produced no output
    if (r.exitCode !== 0 && (!reviewerOutput || reviewerOutput.trim().length === 0)) {
      return { iterations: i, clean: false, summary: `❌ Reviewer crashed at round ${i} (exit ${r.exitCode})` };
    }
    // Abort if reviewer was killed by signal — output may be partial/garbled
    if (r.exitCode === null) {
      return { iterations: i, clean: false, summary: `❌ Reviewer killed (signal) at round ${i}` };
    }
    if (!reviewerOutput || reviewerOutput.trim().length === 0) {
      return { iterations: i, clean: false, summary: `❌ Reviewer produced no output at round ${i}` };
    }

    const cleanMatch = reviewerOutput.match(/CLEAN:\s*(true|false)/i);
    const foundMatch = reviewerOutput.match(/FOUND:\s*(\d+)/i);
    const isClean = cleanMatch ? cleanMatch[1].toLowerCase() === "true" : false;
    const issuesCount = foundMatch ? parseInt(foundMatch[1], 10) : (isClean ? 0 : 1);
    // Guard: CLEAN: false but FOUND: 0 is contradictory — ensure at least 1 fix iteration
    const actualIssuesCount = (!isClean && issuesCount === 0) ? 1 : issuesCount;

    // When CLEAN: true, mark actualIssuesCount as 0 regardless of FOUND value
    const actualIssuesCountForIter = isClean ? 0 : actualIssuesCount;

    iterations.push({ iter: i, issuesFound: actualIssuesCountForIter, clean: isClean });

    if (isClean) {
      const summary = iterations.map(it =>
        `Round ${it.iter}: ${it.issuesFound} issue(s) → ${it.clean ? "CLEAN" : "FIXED"}`
      ).join("\n");
      return { iterations: i, clean: true, summary: `✅ CLEAN after ${i} rounds\n` + summary };
    }

    const fixerOutput = await runAction(actualIssuesCount, reviewerOutput, i);
    // Detect fixer failure — empty output or spawn errors
    if (!fixerOutput || fixerOutput.trim().length === 0) {
      return { iterations: i, clean: false, summary: `❌ Fixer produced no output at round ${i}. Aborting.` };
    }
    if (/^\[Sub-agent (error|spawn error|denied|timeout)/.test(fixerOutput)) {
      return { iterations: i, clean: false, summary: `❌ Fixer failed at round ${i}: ${fixerOutput.substring(0, 200)}` };
    }
    if (commitPrefix !== "") commitWorktree(workCwd, commitPrefix, `iteration ${i}: ${actualIssuesCount} issue(s)`);
  }

  const summary = iterations.map(it =>
    `Round ${it.iter}: ${it.issuesFound} issue(s) → ${it.clean ? "CLEAN" : "FIXED"}`
  ).join("\n");
  return { iterations: maxIterations, clean: false, summary: `⚠ MAX ROUNDS (${maxIterations})\n` + summary };
}

// ── Mode Handlers ───────────────────────────────────────────────────────

/**
 * ANALYZE: read-only exploration → review → improve → loop → final report.
 */
async function handleAnalyzeMode(task: string, ctxCwd: string, maxIt: number): Promise<LoopResult> {
  // Phase 1: initial exploration with cheap model (use sub-process, not worktree)
  const initTask = `Explore and analyze: ${task}\n\nBe thorough. DO NOT modify any files. Produce a comprehensive analysis.`;
  const initR = await runSubProcess(initTask, ctxCwd, _cheapModel);
  let analysis = initR.stdout + (initR.stderr ? "\n" + initR.stderr : "");

  // Bail early if initial exploration failed
  if (initR.exitCode !== 0 && (!analysis || analysis.trim().length === 0)) {
    return { iterations: 0, clean: false, summary: `❌ Initial exploration crashed (exit ${initR.exitCode})` };
  }
  if (!analysis || analysis.trim().length === 0) {
    return { iterations: 0, clean: false, summary: "❌ Initial exploration produced no output." };
  }

  // Phase 2: review loop — improve analysis quality iteratively
  const result = await reviewLoop(
    ctxCwd, ctxCwd,
    (_i) => [
      `Review this analysis. Identify gaps, inaccuracies, or missing details.`,
      `--- ANALYSIS ---`, analysis.substring(0, 24000), `--- END ---`,
      `FOUND: <number>`, `CLEAN: <true|false>`, `ISSUES:`,
      `- <issue>`,
      `If CLEAN: true, just write "CLEAN: true".`,
    ].join("\n"),
    async (_c, reviewerOutput, _i) => {
      const r = await runSubProcess(
        `Improve this analysis based on feedback. Produce a complete final analysis. DO NOT modify files.\n\n` +
        `Feedback: ${reviewerOutput.substring(0, 4000)}`,
        ctxCwd,
        _defaultModel
      );
      const improved = r.stdout + (r.stderr ? "\n" + r.stderr : "");
      if (improved.trim().length > 0) analysis = improved; // update for next review round
      return improved;
    },
    maxIt, ""
  );
  return result;
}

/**
 * IMPROVE: review diff → fix → re-review loop.
 */
async function handleImproveMode(
  targetAgentId: string | null, ctxCwd: string,
  criteria: string | undefined, maxIt: number,
  task?: string
): Promise<LoopResult> {
  const existing = targetAgentId ? subAgents.get(targetAgentId) : null;
  if (existing && existing.status === "running") {
    return { iterations: 0, clean: false, summary: "Sub-agent still running." };
  }

  // If targetAgentId given but agent not in map, try to reconstruct worktree path
  let workCwd: string;
  if (existing) {
    workCwd = existing.worktreePath;
  } else if (targetAgentId) {
    const safe = safeId(targetAgentId);
    // Use hash-based fallback if safeId fails — ensures deterministic paths
    // Use the same fallback logic as branchName() to reconstruct the worktree path
    const dirComponent = safe || `fallback-${createHash("sha1").update(targetAgentId).digest("hex").substring(0, 12)}`;
    const reconstructed = join(projectRoot(ctxCwd), ".pi", "subagent", dirComponent);
    if (existsSync(reconstructed)) {
      // Verify the branch still exists — worktree without branch is useless
      try { git(["rev-parse", "--verify", branchName(targetAgentId)], ctxCwd); }
      catch {
        return { iterations: 0, clean: false, summary: `Sub-agent ${targetAgentId} worktree exists but branch is missing.` };
      }
      workCwd = reconstructed;
    } else {
      // Branch may have been cleaned up already
      try { git(["rev-parse", "--verify", branchName(targetAgentId)], ctxCwd); } catch {
        return { iterations: 0, clean: false, summary: `Sub-agent ${targetAgentId} not found (branch cleaned up).` };
      }
      return { iterations: 0, clean: false, summary: `Sub-agent ${targetAgentId} branch exists but worktree is missing.` };
    }
  } else {
    workCwd = ctxCwd;
  }

  const reviewCriteria = criteria || "Check correctness, security, performance, style, edge cases, and completeness.";

  return reviewLoop(
    ctxCwd, workCwd,
    (_i) => {
      const parts = [`Review criteria: ${reviewCriteria}`];
      if (task) {
        parts.push(`TASK: ${task}`);
        parts.push(`Read the code files directly — use read, bash, serena tools to inspect the codebase.`);
      } else if (targetAgentId) {
        const diffContent = getDiff(ctxCwd, targetAgentId);
        if (diffContent) parts.push(`--- DIFF ---`, diffContent.substring(0, 24000), `--- END ---`);
      }
      parts.push(`FOUND: <number>`, `CLEAN: <true|false>`, `ISSUES:`, `- <issue with file+line>`);
      return parts.join("\n");
    },
    async (issuesCount, reviewerOutput, _i) => {
      // Fixer runs directly in the target worktree (no merge needed)
      // reviewLoop handles committing after each fixer round — no inline commit needed.
      const fixerTask = `Fix ${issuesCount} issue(s):\n\n${reviewerOutput.substring(0, 4000)}\n\nMake concrete edits to the files.`;
      const r = await runSubProcess(fixerTask, workCwd, _cheapModel || _defaultModel, "read,edit,write,bash");
      const output = r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : "");
      return output;
    },
    maxIt,
    targetAgentId ? `improve-${safeId(targetAgentId) || "unknown"}` : "improve"
  );
}

/**
 * EXECUTE: walk todo items; each: execute → improve loop → next.
 * After each item, the sub-agent's branch is auto-merged (on success) or rejected (on failure).
 */
async function handleExecuteMode(
  items: { description: string }[], ctxCwd: string, maxIt: number
): Promise<{ results: string[]; allClean: boolean }> {
  const results: string[] = [];
  let allClean = true;
  const root = projectRoot(ctxCwd);

  itemLoop: for (let i = 0; i < items.length; i++) {
    evictTerminalAgents(); // periodic cleanup of stale agent records
    const item = items[i];
    const { id: execId, promise: execPromise } = spawnSubAgent(
      `Execute: ${item.description}. Make changes as needed.`,
      ctxCwd
    );
    let retainForManualReview = false;
    try {
      const execResult = await execPromise;
      const ag = subAgents.get(execId);
      if (ag) {
        if (ag.status === "error" || execResult.startsWith("[Sub-agent error") || execResult.startsWith("[Sub-agent denied") || execResult.startsWith("[Sub-agent timeout") || execResult.startsWith("[Sub-agent spawn error")) {
          results.push(`${i + 1}. ${item.description}: ✗ error (${(ag.error || execResult.substring(0, 100))})`);
          allClean = false;
          // Reject: delete branch + worktree for failed items
          cleanupWorktree(root, execId, true);
        } else {
          try {
            const ir = await handleImproveMode(execId, ctxCwd, undefined, maxIt);
            results.push(`${i + 1}. ${item.description}: ${ir.clean ? "✅" : "⚠"} (${ir.iterations}r)`);
            if (!ir.clean) allClean = false;
            // Auto-merge the improved branch into main
            let mergeHadConflicts = false;
            try {
              const branch = branchName(execId);
              try { git(["rev-parse", "--verify", branch], ctxCwd); }
              catch { /* branch missing, skip merge */ cleanupWorktree(root, execId, true); continue itemLoop; }
              // Stash any dirty state before merging (safer than checkpoint commits)
              let stashed = false;
              if (gitQuiet(["status", "--porcelain"], ctxCwd).trim()) {
                gitQuiet(["stash", "push", "-m", `pi: auto-stash before merge ${execId}`], ctxCwd);
                stashed = true;
              }
              try {
                git(["merge", "--no-commit", "--no-ff", branch], ctxCwd);
                git(["commit", "-m", `pi: auto-merge ${execId}: ${item.description.substring(0, 60)}`, "--no-edit"], ctxCwd);
                // Pop stash on successful merge
                if (stashed) gitQuiet(["stash", "pop"], ctxCwd);
              } catch (mergeErr: any) {
                // Check if this is actually a conflict (unmerged files) vs. a transient error
                const unmerged = gitQuiet(["ls-files", "-u"], ctxCwd).trim();
                if (unmerged.length > 0) {
                  // Genuine merge conflict — abort and leave branch for manual review
                  gitQuiet(["merge", "--abort"], ctxCwd);
                  mergeHadConflicts = true;
                  retainForManualReview = true;
                  results.push(`  ⚠ Auto-merge of ${execId} had conflicts — branch retained for manual merge.`);
                } else {
                  // Transient error (disk full, permissions, etc.) — abort and fail cleanly
                  gitQuiet(["merge", "--abort"], ctxCwd);
                  mergeHadConflicts = false;
                  results.push(`  ⚠ Auto-merge of ${execId} failed: ${(mergeErr.message || "").substring(0, 80)}`);
                }
                // Pop stash back (merge was aborted, so working tree is clean)
                if (stashed) gitQuiet(["stash", "pop"], ctxCwd);
              }
            } catch (e: any) { console.debug("handleExecuteMode: merge subsystem failed", e?.message || e); }
            // Clean up worktree + branch + map entry after merge attempt
            // (skip if conflicts — branch is intentionally retained for manual review)
            if (!mergeHadConflicts) {
              cleanupWorktree(root, execId, true);
              subAgents.delete(execId);
            }
          } catch (e: any) {
            results.push(`${i + 1}. ${item.description}: ✗ improve crashed (${(e.message || "").substring(0, 100)})`);
            allClean = false;
            cleanupWorktree(root, execId, true);
          }
        }
      } else {
        results.push(`${i + 1}. ${item.description}: ✗ failed (no agent record)`);
        allClean = false;
        cleanupWorktree(root, execId, true);
      }
    } finally {
      if (!retainForManualReview) subAgents.delete(execId);
    }
  }

  return { results, allClean };
}

// ── git helpers ─────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const err: any = new Error(result.stderr?.trim() || `git ${args[0]} exited with code ${result.status}`);
    err.stderr = result.stderr || "";
    err.stdout = result.stdout || "";
    err.status = result.status;
    throw err;
  }
  return result.stdout || "";
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
    // Verify it's usable — but don't destroy on transient errors.
    // Only nuke if .git/HEAD is missing (fundamentally broken)
    try {
      git(["rev-parse", "--git-dir"], projectRoot);
      return projectRoot;
    } catch {
      if (!existsSync(join(gitDir, "HEAD"))) {
        // Truly corrupted — remove and re-init
        try {
          rmSync(gitDir, { recursive: true, force: true });
        } catch { /* can't remove, will fail below */ }
      }
      // HEAD exists but rev-parse failed — try to repair before falling through
      if (existsSync(gitDir)) {
        // Attempt recovery: if basic git commands work, the failure was transient
        try {
          git(["symbolic-ref", "HEAD"], projectRoot);
          return projectRoot;
        } catch {
          // Recovery failed — force-remove as last resort
          try {
            rmSync(gitDir, { recursive: true, force: true });
          } catch {
            throw new Error(
              `Cannot initialize git repo at ${projectRoot}: .git is corrupted and cannot be removed.`
            );
          }
        }
      }
    }
  }

  // Guard: if .git still exists (unremovable corrupted repo), error out
  // instead of falling through to git init which would also fail
  if (existsSync(gitDir)) {
    throw new Error(
      `Cannot initialize git repo at ${projectRoot}: .git still exists after repair attempt.`
    );
  }

  // Force init
  try {
    git(["init"], projectRoot);
  } catch (e: any) {
    throw new Error(`git init failed: ${e.stderr || e.message}`);
  }
  // Create initial commit so worktree add works
  try {
    git(["add", "-A", "--ignore-errors"], projectRoot);
    git(["commit", "-m", "pi: initial snapshot (auto-created for sub-agent tracking)", "--allow-empty"], projectRoot);
  } catch {
    git(["commit", "-m", "pi: initial snapshot", "--allow-empty"], projectRoot);
  }

  return projectRoot;
}

/** Create a worktree + branch for a sub-agent. Returns the worktree path. */
function createWorktree(projectRoot: string, id: string): string {
  const safe = safeId(id);
  if (!safe) throw new Error(`Invalid sub-agent id for worktree: "${id.substring(0, 40)}"`);
  const branch = branchName(id);
  const wtDir = join(projectRoot, ".pi", "subagent", safe);

  // Ensure .pi/subagent directory exists
  mkdirSync(join(projectRoot, ".pi", "subagent"), { recursive: true });

  // Remove stale worktree if exists
  gitQuiet(["worktree", "remove", "--force", wtDir], projectRoot);
  // Remove stale branch if exists (force delete — stale branches from crashed
  // sub-agents should be replaced, not preserved)
  gitQuiet(["branch", "-D", branch], projectRoot);

  // Ensure HEAD is valid (needed for branch creation)
  let headRef: string;
  try { headRef = git(["rev-parse", "--verify", "HEAD"], projectRoot).trim(); }
  catch { git(["commit", "-m", "pi: placeholder", "--allow-empty"], projectRoot); headRef = git(["rev-parse", "--verify", "HEAD"], projectRoot).trim(); }

  // Create branch from resolved HEAD ref
  git(["branch", branch, headRef], projectRoot);

  // Verify branch exists before trying to create worktree
  try { git(["rev-parse", "--verify", branch], projectRoot); }
  catch (e: any) { throw new Error(`Failed to create branch ${branch}: ${e.message || e}`); }

  // Create worktree — use git() directly to detect failure by exit code, not string matching
  try {
    git(["worktree", "add", wtDir, branch], projectRoot);
  } catch (e: any) {
    // Branch was created but worktree failed — clean up the orphan branch
    gitQuiet(["branch", "-d", branch], projectRoot);
    throw new Error(`Worktree add failed: ${e.stderr || e.message}`);
  }

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

/** Commit changes in the worktree directly (run git from the worktree path, not the main repo). */
function commitWorktree(worktreePath: string, id: string, task: string): string {
  const msg = `pi: ${id} — ${task.substring(0, 80)}`;
  let lastHash = "";
  const repo = worktreePath;
  if (repo && existsSync(join(repo, ".git"))) {
    try {
      if (gitQuiet(["status", "--porcelain"], repo).trim()) {
        gitQuiet(["add", "-A"], repo);
        gitQuiet(["commit", "-m", msg], repo);
        lastHash = gitQuiet(["rev-parse", "--short", "HEAD"], repo).trim() || lastHash;
      }
    } catch { /* ok */ }
  }
  return lastHash;
}

/** Clean up worktree and optionally the branch */
function cleanupWorktree(projectRoot: string, id: string, deleteBranch: boolean): { branchDeleted: boolean; worktreeRemoved: boolean } {
  const safe = safeId(id);
  if (!safe) return { branchDeleted: false, worktreeRemoved: false }; // invalid id, nothing to clean up
  const wtDir = join(projectRoot, ".pi", "subagent", safe);
  const branch = branchName(safe);
  let worktreeRemoved = false;
  let branchDeleted = false;
  // Remove git worktree metadata first
  try { git(["worktree", "remove", "--force", wtDir], projectRoot); worktreeRemoved = true; } catch { /* ok */ }
  // Always try to remove the directory — git worktree remove may leave stale dirs behind
  try { rmSync(wtDir, { recursive: true, force: true }); worktreeRemoved = true; } catch { /* ok */ }
  if (deleteBranch) {
    try { git(["branch", "-d", branch], projectRoot); branchDeleted = true; } catch { /* ok */ }
  }
  return { branchDeleted, worktreeRemoved };
}

// ── sub-process runner ───────────────────────────────────────────────────────

/** Run pi as a sub-process directly in a given directory (no worktree). */
function runSubProcess(task: string, cwd: string, model?: string, tools?: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  // Sub-processes (reviewers, fixers) should use a shorter timeout — 30s floor, 2min default, 20min ceiling
  const killTimeout = Math.max(Math.min(timeoutMs || 120_000, 1_200_000), 30_000);
  const depth = currentDepth();
  return new Promise((resolve) => {
    const args: string[] = ["-p"];
    if (model) args.push("--model", model);
    if (tools) args.push("--tools", tools);
    args.push("\n" + task);
    const proc = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_SUBAGENT_DEPTH: String(depth + 1),
        PI_SUBAGENT_ROOT: projectRoot(cwd),
      },
    });
    let stdout = "";
    let stderr = "";
    let resolved = false;
    let exitCode: number | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
        resolve({ stdout, stderr, exitCode });
      }
    };
    proc.on("close", (code) => { exitCode = code; done(); });
    proc.on("error", (err: Error) => {
      stderr = `[spawn error] ${err.message}`;
      exitCode = -2;
      done();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      forceKillTimer = setTimeout(() => { forceKillTimer = null; try { proc.kill("SIGKILL"); } catch { /* ok */ } }, 10_000);
      exitCode = -1;
      done();
    }, killTimeout);
  });
}

// ── depth tracking ─────────────────────────────────────────────────────────

const MAX_DEPTH = 5;

function currentDepth(): number {
  const d = parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);
  return isNaN(d) ? 0 : d;
}

/** Resolve the nearest git repo root from a starting directory. */
function resolveGitRoot(cwd: string): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd).trim();
  } catch {
    // Check if we're inside a git worktree (git rev-parse fails in subdirs of a worktree sometimes)
    try {
      const commonDir = git(["rev-parse", "--git-common-dir"], cwd).trim();
      // --git-common-dir returns ".git" (relative) in a regular repo
      // or an absolute path to the shared .git in a worktree
      if (commonDir === ".git") {
        return cwd;
      }
      return commonDir.replace(/\/\.git$/, "");
    } catch {
      // Last resort: walk up looking for .git
      let dir = cwd;
      for (let i = 0; i < 32; i++) {
        if (existsSync(join(dir, ".git"))) return dir;
        const parent = join(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
      return cwd; // absolute fallback
    }
  }
}

function projectRoot(cwd: string): string {
  return process.env.PI_SUBAGENT_ROOT || resolveGitRoot(cwd);
}

// ── spawn sub-agent ─────────────────────────────────────────────────────────

function spawnSubAgent(
  task: string,
  cwd: string,
  options?: {
    model?: string;
    tools?: string[];
    systemPrompt?: string;
    timeoutMs?: number; // override process kill timeout (floor: 20 min)
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

  evictTerminalAgents(); // prevent unbounded map growth
  const id = shortId();
  const startTime = Date.now();

  // Use original project root (set by top-level pi), not worktree cwd
  let root: string;
  try {
    root = ensureGitRepo(projectRoot(cwd));
  } catch (e: any) {
    const errMsg = `Failed to initialize git repository: ${e.message}`;
    return {
      id,
      promise: Promise.resolve(`[Sub-agent error] ${errMsg}`),
    };
  }
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
    const args: string[] = ["-p"];
    
    if (options?.tools) {
      const toolsArg = Array.isArray(options.tools) ? options.tools.join(",") : options.tools;
      args.push("--tools", toolsArg);
    }
    if (options?.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    if (options?.model) args.push("--model", options.model);
    // Prefix with "\n" to prevent task text from being parsed as a CLI option
    args.push("\n" + task);

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

    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout;

    function settle(result: string, status: "done" | "error" | "cancelled") {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
      agent.status = status;
      agent.endTime = Date.now();
      resolve(result);
    }

    proc.on("close", (code) => {
      if (settled) return;
      // Note: agent may have been removed from subAgents map externally (TOCTOU race).
      // Always settle with the actual process output rather than checking the map,
      // which could race with external cleanup code.
      // Cancellation handled: settle so the promise resolves instead of hanging
      if (agent.status === "cancelled") {
        settle("[Sub-agent cancelled]", "cancelled");
        return;
      }

      if (code === 0) {
        agent.result = stdout.trim();
        // Auto-commit changes made by the sub-agent
        agent.commitHash = commitWorktree(worktreePath, id, task);
        settle(stdout.trim(), "done");
      } else {
        agent.error = stderr.trim() || `exit code ${code}`;
        settle(`[Sub-agent error (${code})] ${agent.error}\n\nOutput:\n${stdout.trim().substring(0, 3000)}`, "error");
      }
    });

    proc.on("error", (err) => {
      agent.error = err.message;
      settle(`[Sub-agent spawn error] ${err.message}`, "error");
    });

    // Kill process after timeout (min 20 min, configurable via options)
    const killTimeout = Math.max(options?.timeoutMs || 1_200_000, 1_200_000);
    killTimer = setTimeout(() => {
      if (agent.status === "running" && !settled) {
        // Escalation: SIGTERM → 10s grace → SIGKILL
        proc.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null;
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        }, 10_000);
        agent.error = `timeout (${Math.round(killTimeout / 60_000)} min)`;
        settle(`[Sub-agent timeout after ${Math.round(killTimeout / 60_000)} min]\n\nPartial:\n${stdout.trim().substring(0, 2000)}`, "error");
      }
    }, killTimeout);
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
          cleanupWorktree(projectRoot(ctx.cwd), rest, true);
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
            "│   subagent_spawn (mode=improve) — review→fix→re-review",
            "│   subagent_review    — inspect git diff",
            "│   subagent_merge     — merge branch → main",
            "│   subagent_reject    — delete branch + worktree",
            "│   subagent_parallel  — fan-out N agents",
            "│   subagent_spawn (mode=execute) — todo-driven sequential pipeline",
            "└───────────────────────────────────────────",
          ]);
        }
      }
    },
  });

  // ── subagent_spawn (unified entry) ─────────────────────────────────────
  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Sub-agent",
    description:
      "Spawn a sub-agent in an isolated git worktree. Supports 3 workflow modes:\n" +
      "- `analyze`: read-only exploration → review → improve → final report (no code changes)\n" +
      "- `improve`: analyze target → review → fix → re-review loop until clean (subagentId optional; without it, analyzes cwd first)\n" +
      "- `execute`: walk todo items; each: execute → improve loop → next (needs todo items list)",
    promptSnippet: "Spawn a sub-agent (analyze/improve/execute).",
    promptGuidelines: [
      "Use mode='analyze' for research/exploration tasks — it self-improves the analysis quality.",
      "Use mode='improve' to review and fix code. Pass subagentId to improve an existing agent's work, or omit it to improve the current codebase directly.",
      "Use mode='execute' with a todo list to churn through tasks, each with its own improve loop.",
      "Always review sub-agent output before merging — never merge blindly.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task description for the sub-agent" }),
      mode: Type.String({ description: "Workflow: 'analyze', 'improve', or 'execute'" }),
      model: Type.Optional(Type.String({ description: "Model override" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Max runtime ms (min: 20 min, default: 20 min)" })),
      subagentId: Type.Optional(Type.String({ description: "Target sub-agent ID to improve (any source). If omitted, improves current codebase." })),
      criteria: Type.Optional(Type.String({ description: "Review criteria (improve mode)" })),
      maxIterations: Type.Optional(Type.Number({ description: "Max review-action rounds (default: 20, max: 20)" })),
      todoItems: Type.Optional(Type.String({ description: "JSON array of {description: string} (execute mode)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const maxIt = Math.min(params.maxIterations || 20, 20);

      // ── ANALYZE mode ────────────────────────────────────────────────
      if (params.mode === "analyze") {
        const result = await handleAnalyzeMode(params.task, ctx.cwd, maxIt);
        return { content: [{ type: "text", text: result.summary }], details: { mode: "analyze", ...result } };
      }

      // ── IMPROVE mode ────────────────────────────────────────────────
      if (params.mode === "improve") {
        // If no subagentId, improve the current codebase directly (no worktree)
        // This avoids cross-repo mismatch when extensions live in a different git repo
        if (!params.subagentId) {
          const result = await handleImproveMode(null, ctx.cwd, params.criteria, maxIt, params.task);
          return { content: [{ type: "text", text: result.summary }], details: { mode: "improve", ...result } };
        }

        // If subagentId provided, improve the target sub-agent's worktree
        const result = await handleImproveMode(params.subagentId, ctx.cwd, params.criteria, maxIt);
        try {
          const ag = subAgents.get(params.subagentId);
          if (ag && ag.status !== "running") {
            // Stash any dirty state before merging to avoid merge failures
            let stashed = false;
            if (gitQuiet(["status", "--porcelain"], ctx.cwd).trim()) {
              gitQuiet(["stash", "push", "-m", `pi: auto-stash before merge ${params.subagentId}`], ctx.cwd);
              stashed = true;
            }
            try { git(["merge", "--no-edit", branchName(params.subagentId)], ctx.cwd); } catch { /* merge can fail */ }
            if (stashed) gitQuiet(["stash", "pop"], ctx.cwd);
            cleanupWorktree(projectRoot(ctx.cwd), params.subagentId, true);
            subAgents.delete(params.subagentId);
          }
        } catch { /* best effort cleanup */ }
        return { content: [{ type: "text", text: result.summary }], details: { mode: "improve", ...result } };
      }

      // ── EXECUTE mode ────────────────────────────────────────────────
      if (params.mode === "execute") {
        let items: { description: string }[];
        try {
          const parsed = JSON.parse(params.todoItems || "[]");
          if (!Array.isArray(parsed)) throw new Error("not array");
          items = parsed;
        } catch {
          return { content: [{ type: "text", text: "todoItems must be a JSON array of {description: string}." }], details: {}, isError: true };
        }
        if (items.length === 0) {
          return { content: [{ type: "text", text: "No todo items provided." }], details: {}, isError: true };
        }
        const result = await handleExecuteMode(items, ctx.cwd, maxIt);
        const summary = [
          `┌─ Execute Complete ──────────────────────`,
          ...result.results.map(r => `│ ${r}`),
          `└──────────────────────────────────────────`,
          result.allClean ? "All items passed." : "Some items need attention.",
        ].join("\n");
        return { content: [{ type: "text", text: summary }], details: { allClean: result.allClean } };
      }

      // ── Unknown mode ────────────────────────────────────────────────
      return { content: [{ type: "text", text: `Unknown mode "${params.mode}". Use: analyze, improve, or execute.` }], details: {}, isError: true };
    },
  });

  // ── subagent_wait ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Sub-agent",
    description: "Wait for a sub-agent to complete. Returns the result and indicates whether changes were committed.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Max wait ms (default: 1200000 = 20 min)" })),
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

      const deadline = Date.now() + (params.timeoutMs || 1_200_000);
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
      if (gitQuiet(["status", "--porcelain"], ctx.cwd).trim()) { return { content: [{ type: "text", text: "Working tree has uncommitted changes. Commit or stash before merging." }], details: {}, isError: true }; }
      const ag = subAgents.get(params.id);
      if (ag && ag.status === "running") return { content: [{ type: "text", text: `Sub-agent ${params.id} is still running. Wait for completion or cancel first.` }], details: {}, isError: true };

      // Verify branch exists before attempting merge
      try { git(["rev-parse", "--verify", branch], ctx.cwd); }
      catch { return { content: [{ type: "text", text: `Branch ${branch} for sub-agent ${params.id} not found. It may have been cleaned up already.` }], details: {}, isError: true }; }

      // Try merge
      try {
        // Attempt merge — catch both conflicts and other errors
        let mergeSucceeded = false;
        let mergeError = "";
        try {
          git(["merge", "--no-commit", "--no-ff", branch], ctx.cwd);
          mergeSucceeded = true;
        } catch (e: any) {
          mergeError = e.stderr || e.message || "";
        }

        if (!mergeSucceeded) {
          const isConflict = mergeError.includes("CONFLICT");

          // Capture conflicting files BEFORE aborting the merge
          let conflictFiles = "";
          if (isConflict) {
            conflictFiles = gitQuiet(["diff", "--name-only", "--diff-filter=U"], ctx.cwd);
          }
          // Abort to leave working tree clean
          gitQuiet(["merge", "--abort"], ctx.cwd);

          if (isConflict) {
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

          return {
            content: [{ type: "text", text: `Merge failed for ${params.id}: ${mergeError.substring(0, 500)}` }],
            details: {},
            isError: true,
          };
        }

        // Clean merge — commit it
        git(["commit", "-m", `pi: merge subagent ${params.id}: ${ag?.task?.substring(0, 60) || "delegated task"}`, "--no-edit"], ctx.cwd);

        // Update agent status
        if (ag) ag.status = "merged";

        // Clean up worktree (keep branch for history)
        cleanupWorktree(projectRoot(ctx.cwd), params.id, false);
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
      // Attempt cleanup even if agent is not in the map (e.g., after subagent_parallel)
      // by checking if the worktree/branch exists
      if (ag) {
        if (ag.status === "running") {
          if (ag.proc) { try { ag.proc.kill("SIGKILL"); } catch { /* ok */ } }
        }
        ag.status = "rejected";
      }

      const result = cleanupWorktree(projectRoot(ctx.cwd), params.id, true);
      if (ag) subAgents.delete(params.id);

      const msgs = [`🗑 Sub-agent ${params.id} rejected.`];
      if (result.branchDeleted) {
        msgs.push(`Branch ${branchName(params.id)} deleted.`);
      } else {
        msgs.push(`Branch ${branchName(params.id)} not found or could not be deleted.`);
      }
      if (result.worktreeRemoved) {
        msgs.push(`Worktree removed.`);
      } else {
        msgs.push(`Worktree not found or could not be removed.`);
      }

      return {
        content: [{
          type: "text",
          text: msgs.join("\n"),
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
      "After all parallel sub-agents complete, use subagent_spawn(mode=improve) on each to auto-polish, then review with subagent_review before merging.",
      "For tasks that depend on each other, use subagent_spawn(mode=execute) instead.",
    ],
    parameters: Type.Object({
      tasks: Type.String({ description: "JSON array of task strings" }),
      model: Type.Optional(Type.String({ description: "Model override" })),
      maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent (default: 5)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Max runtime ms per sub-agent (min: 20 min, default: 20 min)" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist for each sub-agent" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for each sub-agent" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let tasks: string[];
      try {
        const parsed = JSON.parse(params.tasks);
        if (!Array.isArray(parsed) || parsed.some((t: any) => typeof t !== "string")) {
          return { content: [{ type: "text", text: "tasks must be a JSON array of strings." }], details: {}, isError: true };
        }
        tasks = parsed;
      } catch {
        tasks = params.tasks.split("\n").filter((t: string) => t.trim());
      }
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks provided." }], details: {}, isError: true };
      }

      const maxCon = Math.max(Math.floor(params.maxConcurrency || 5), 1);
      const results: { task: string; id: string; result: string; status: string; elapsed: number; commitHash?: string }[] = [];

      for (let i = 0; i < tasks.length; i += maxCon) {
        const batch = tasks.slice(i, i + maxCon);
        const batchPromises = batch.map((task) => {
          const { id, promise } = spawnSubAgent(task, ctx.cwd, {
            model: params.model,
            timeoutMs: params.timeoutMs,
            tools: params.tools ? params.tools.split(",") : undefined,
            systemPrompt: params.systemPrompt,
          });
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
        // NOTE: agents kept in map so subagent_merge/subagent_reject tools can operate.
        // Caller must review then merge or reject each sub-agent to clean up worktrees/branches.
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
      if (ag.proc) { try { ag.proc.kill("SIGKILL"); } catch { /* ok */ } }
      cleanupWorktree(projectRoot(ctx.cwd), params.id, true);
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
