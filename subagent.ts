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
import { existsSync, lstatSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolvePiBin } from "./btw.js";

// ── types ───────────────────────────────────────────────────────────────────

interface SubAgent {
  id: string;
  branch: string;
  worktreePath: string;
  projectRoot: string;
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
    if (["done", "error", "merged", "rejected", "cancelled"].includes(ag.status) && ag.endTime && (now - ag.endTime) > EVICTION_AGE_MS) {
      // Clean up worktree on disk before removing from map.
      // Preserve git branches for "done" (completed but unmerged) and "merged" agents
      // since they contain committed work that may be valuable.
      if (ag.projectRoot) {
        cleanupWorktree(ag.projectRoot, ag.id, ag.status !== "done" && ag.status !== "merged");
      } else if (ag.worktreePath) {
        // Fallback: try to resolve project root from worktree path for proper cleanup.
        // This handles edge cases where the agent record lacks projectRoot but the
        // worktree directory still exists (e.g., agents created before projectRoot was tracked).
        try {
          const resolved = resolveGitRoot(ag.worktreePath);
          if (resolved && resolved !== ag.worktreePath) {
            cleanupWorktree(resolved, ag.id, ag.status !== "done" && ag.status !== "merged");
          } else {
            try { rmSync(ag.worktreePath, { recursive: true, force: true }); } catch { /* ok */ }
          }
        } catch {
          try { rmSync(ag.worktreePath, { recursive: true, force: true }); } catch { /* ok */ }
        }
      }
      subAgents.delete(id);
    }
  }
}

/** Sentinel file path used to distinguish stale (interrupted) from completed-but-unmerged worktrees */
function sentinelPath(root: string, id: string): string {
  const safe = safeId(id);
  if (!safe) return "";
  return join(root, ".pi", "subagent", `.${safe}.sentinel`);
}

function shortId(): string {
  return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Validate/sanitize a potentially user-provided sub-agent id for use in git branch names.
 *  Returns a safe version or null if the id is completely invalid. */
function safeId(raw: string): string | null {
  const hash = createHash("sha1").update(raw).digest("hex").substring(0, 8);
  // Allow alphanumeric, dash, underscore. Replace anything else.
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  if (cleaned.length === 0 || cleaned.length > 71) return null;
  return `${cleaned}-${hash}`;
}

// Read default/cheap model from pi settings
let _defaultModel: string | undefined;
let _cheapModel: string | undefined;

function refreshModels() {
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
      _cheapModel = derived !== _defaultModel ? derived : undefined;
    }
  } catch (e: any) {
    // Settings file may not exist yet, or may contain invalid JSON
    console.debug("subagent: failed to load settings.json", e.message);
  }
}

refreshModels();

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
  commitPrefix = "loop",
  signal?: AbortSignal,
  todoMatchKey?: string // unique key for todo bridge updates (avoids substring collisions)
): Promise<LoopResult> {
  const iterations: { iter: number; issuesFound: number; clean: boolean }[] = [];

  for (let i = 1; i <= MAX_ROUNDS; i++) {
    if (signal?.aborted) return { iterations: i, clean: false, summary: "❌ Cancelled by user during review loop." };
    // Update todo progress if bridge available
    const tb = (globalThis as any).__pi_todo;
    if (tb && todoMatchKey) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "in_progress", `🔍 improve round ${i}/${MAX_ROUNDS}: reviewing...`);

    evictTerminalAgents(); // periodic cleanup of stale agent records
    const reviewTask = buildReviewTask(i);
    // Reviewer runs directly (no worktree) — it only reads and reports
    let r;
    try {
      r = await runSubProcess(reviewTask, workCwd, _defaultModel, "read,bash,serena_search_pattern,serena_overview", undefined, signal);
    } catch (e: any) {
      return { iterations: i, clean: false, summary: `❌ Reviewer failed to start at round ${i}: ${(e.message || e).substring(0, 200)}` };
    }
    const reviewerOutput = r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : "");

    // Abort if reviewer was killed by signal — output may be partial/garbled
    if (r.exitCode === null) {
      return { iterations: i, clean: false, summary: `❌ Reviewer killed (signal) at round ${i}` };
    }
    // Abort if reviewer timed out — distinct from a crash
    if (r.exitCode === -1) {
      return { iterations: i, clean: false, summary: `❌ Reviewer timed out at round ${i}` };
    }
    // Abort if reviewer was cancelled by signal (exitCode -3 from runSubProcess)
    if (r.exitCode === -3) {
      return { iterations: i, clean: false, summary: `❌ Reviewer cancelled by signal at round ${i}` };
    }
    // Abort if reviewer crashed — non-zero exit indicates failure even if partial output exists
    if (r.exitCode !== 0) {
      return { iterations: i, clean: false, summary: `❌ Reviewer crashed at round ${i} (exit ${r.exitCode})` };
    }
    if (!reviewerOutput || reviewerOutput.trim().length === 0) {
      return { iterations: i, clean: false, summary: `❌ Reviewer produced no output at round ${i}` };
    }

    const cleanMatch = reviewerOutput.match(/^CLEAN:\s*(true|false)/im);
    const foundMatch = reviewerOutput.match(/^FOUND:\s*(\d+)/im);
    const isClean = cleanMatch ? cleanMatch[1].toLowerCase() === "true" : false;
    const issuesCount = foundMatch ? parseInt(foundMatch[1], 10) : (isClean ? 0 : 1);
    // Guard: CLEAN: false but FOUND: 0 is contradictory — ensure at least 1 fix iteration
    const actualIssuesCount = (!isClean && issuesCount === 0) ? 1 : issuesCount;

    // When CLEAN: true, mark actualIssuesCount as 0 regardless of FOUND value
    const actualIssuesCountForIter = isClean ? 0 : actualIssuesCount;

    iterations.push({ iter: i, issuesFound: actualIssuesCountForIter, clean: isClean });

    if (isClean) {
      if (tb && todoMatchKey) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "completed", `✅ improve: clean after ${i} rounds`);
      const summary = iterations.map(it =>
        `Round ${it.iter}: ${it.issuesFound} ${it.issuesFound === 1 ? 'issue' : 'issues'} → ${it.clean ? "CLEAN" : "FIXED"}`
      ).join("\n");
      return { iterations: i, clean: true, summary: `✅ CLEAN after ${i} rounds\n` + summary };
    }

    if (signal?.aborted) return { iterations: i, clean: false, summary: "❌ Cancelled by user during review loop." };
    let fixerOutput: string;
    try {
      fixerOutput = await runAction(actualIssuesCount, reviewerOutput, i);
    } catch (e: any) {
      if (e?.name === "AbortError" || signal?.aborted) {
        return { iterations: i, clean: false, summary: `❌ Cancelled by user at round ${i}.` };
      }
      return { iterations: i, clean: false, summary: `❌ Fixer threw at round ${i}: ${(e.message || e).substring(0, 200)}` };
    }
    if (tb && todoMatchKey) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "in_progress", `🔧 improve round ${i}/${MAX_ROUNDS}: fixed ${actualIssuesCount} ${actualIssuesCount === 1 ? 'issue' : 'issues'}`);
    // Check for cancellation BEFORE empty-output check — a cancelled fixer that is killed
    // before any output is buffered could produce truly empty output rather than the
    // "[cancelled by user]" sentinel. We must detect cancellation first to avoid
    // misreporting it as a fixer failure.
    if (signal?.aborted || /\[cancelled by user\]/.test(fixerOutput)) {
      return { iterations: i, clean: false, summary: `❌ Cancelled by user at round ${i}.` };
    }
    // Detect fixer failure — empty output or spawn errors
    if (!fixerOutput || fixerOutput.trim().length === 0) {
      return { iterations: i, clean: false, summary: `❌ Fixer produced no output at round ${i}. Aborting.` };
    }
    // Require the full bracketed pattern (including closing `]`) to avoid false positives
    // from legitimate output that happens to start with "[Sub-agent error...".
    if (/^\[Sub-agent (?:error|spawn error|denied|timeout)[^\]]*\]/.test(fixerOutput)) {
      return { iterations: i, clean: false, summary: `❌ Fixer failed at round ${i}: ${fixerOutput.substring(0, 200)}` };
    }
    if (commitPrefix !== "") {
      const hash = commitWorktree(workCwd, commitPrefix, `iteration ${i}: ${actualIssuesCount} ${actualIssuesCount === 1 ? 'issue' : 'issues'}`);
      if (!hash) {
        console.error(`reviewLoop: commitWorktree failed at iteration ${i} in ${workCwd}`);
        return { iterations: i, clean: false, summary: `❌ Fix committed but git commit failed at round ${i}. Aborting to avoid stale state.` };
      }
    }
  }

  // Finalize todo item when MAX_ROUNDS reached (non-clean exit)
  const tb = (globalThis as any).__pi_todo;
  if (tb && todoMatchKey) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "completed", `⚠ MAX_ROUNDS (${MAX_ROUNDS}): unresolved issues remain`);

  const summary = iterations.map(it =>
    `Round ${it.iter}: ${it.issuesFound} ${it.issuesFound === 1 ? 'issue' : 'issues'} → ${it.clean ? "CLEAN" : "FIXED"}`
  ).join("\n");
  return { iterations: MAX_ROUNDS, clean: false, summary: `⚠ MAX ROUNDS (${MAX_ROUNDS})\n` + summary };
}

// ── Mode Handlers ───────────────────────────────────────────────────────

/**
 * ANALYZE: read-only exploration → review → improve → loop → final report.
 */
async function handleAnalyzeMode(task: string, ctxCwd: string, signal?: AbortSignal, todoMatchKey?: string): Promise<LoopResult> {
  // Phase 1: initial exploration with cheap model (use sub-process, not worktree)
  const initTask = `Explore and analyze: ${task}\n\nBe thorough. DO NOT modify any files. Produce a comprehensive analysis.`;
  let initR;
  try {
    initR = await runSubProcess(initTask, ctxCwd, _cheapModel, "read,bash,serena_search_pattern,serena_overview", undefined, signal);
  } catch (e: any) {
    return { iterations: 0, clean: false, summary: `❌ Initial exploration failed to start: ${(e.message || e).substring(0, 200)}` };
  }
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
        _defaultModel,
        "read,bash,serena_search_pattern,serena_overview",
        undefined,
        signal
      );
      const improved = r.stdout + (r.stderr ? "\n" + r.stderr : "");
      if (improved.trim().length > 0) analysis = improved; // update for next review round
      // If the sub-process failed to spawn, prefix output so reviewLoop's error regex catches it
      if (r.exitCode !== 0 && (!r.stdout || r.stdout.trim().length === 0)) {
        return `[Sub-agent error] Fixer process failed (exit ${r.exitCode}): ${improved.substring(0, 200)}`;
      }
      return improved;
    },
    "",
    signal,
    todoMatchKey
  );
  return result;
}

/**
 * IMPROVE: review diff → fix → re-review loop.
 */
async function handleImproveMode(
  targetAgentId: string | null, ctxCwd: string,
  criteria: string | undefined,
  task?: string,
  signal?: AbortSignal,
  todoMatchKey?: string // unique key for todo bridge updates
): Promise<LoopResult> {
  const existing = targetAgentId ? subAgents.get(targetAgentId) : null;
  if (existing && existing.status === "running") {
    return { iterations: 0, clean: false, summary: "Sub-agent still running." };
  }

  // If targetAgentId given but agent not in map, try to reconstruct worktree path
  let workCwd: string;
  if (existing) {
    workCwd = existing.worktreePath;
    // Guard: worktree directory may have been externally removed
    if (!existsSync(workCwd)) {
      return { iterations: 0, clean: false, summary: `Sub-agent ${targetAgentId} worktree path ${workCwd} was externally removed.` };
    }
  } else if (targetAgentId) {
    const safe = safeId(targetAgentId);
    if (!safe) {
      return { iterations: 0, clean: false, summary: `Invalid sub-agent ID: "${targetAgentId.substring(0, 40)}"` };
    }
    const reconstructed = join(projectRoot(ctxCwd), ".pi", "subagent", safe);
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
      // reviewLoop handles committing (via commitWorktree) after each fixer round when
      // commitPrefix is non-empty (i.e., when working in a sub-agent worktree).
      // For direct codebase improvement (no targetAgentId), changes are not auto-committed.
      const fixerTask = `Fix ${issuesCount} ${issuesCount === 1 ? 'issue' : 'issues'}:\n\n${reviewerOutput.substring(0, 4000)}\n\nMake concrete edits to the files.`;
      const r = await runSubProcess(fixerTask, workCwd, _cheapModel || _defaultModel, "read,edit,write,bash", undefined, signal);
      const output = r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : "");
      // If the sub-process failed to spawn, prefix output so reviewLoop's error regex catches it
      if (r.exitCode !== 0 && (!r.stdout || r.stdout.trim().length === 0)) {
        return `[Sub-agent error] Fixer process failed (exit ${r.exitCode}): ${output.substring(0, 200)}`;
      }
      return output;
    },
    targetAgentId ? `improve-${safeId(targetAgentId) || "unknown"}` : "",
    signal,
    todoMatchKey
  );
}

/**
 * Auto-merge a sub-agent branch into main. Returns whether the branch should be retained for manual review.
 * This is extracted as a separate function to avoid fragile labeled continues across try/catch boundaries.
 */
function autoMergeBranch(
  ctxCwd: string, execId: string, description: string
): { retainForManualReview: boolean } {
  const result = mergeBranch(ctxCwd, execId, {
    stashPolicy: "auto",
    onCommitFailure: "keep-merge",
    description,
  });
  if (!result.success && result.error && result.error !== "Branch not found") {
    if (result.hasConflicts) {
      console.error(`  ⚠ Auto-merge of ${execId} had conflicts — branch retained for manual merge.`);
    } else {
      console.error(`  ⚠ Auto-merge of ${execId} failed: ${result.error.substring(0, 80)}`);
    }
  }
  return { retainForManualReview: result.retainForManualReview };
}

/**
 * EXECUTE: walk todo items; each: execute → improve loop → next.
 * After each item, the sub-agent's branch is auto-merged (on success) or rejected (on failure).
 */
async function handleExecuteMode(
  items: { description: string }[], ctxCwd: string, signal?: AbortSignal
): Promise<{ results: string[]; allClean: boolean }> {
  const results: string[] = [];
  let allClean = true;
  const root = projectRoot(ctxCwd);

  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) return { results, allClean };
    evictTerminalAgents(); // periodic cleanup of stale agent records
    const item = items[i];
    const { id: execId, promise: execPromise } = spawnSubAgent(
      `Execute: ${item.description}. Make changes as needed.`,
      ctxCwd,
      signal ? { signal } : undefined
    );
    try {
      const execResult = await execPromise;
      const ag = subAgents.get(execId);
      if (ag) {
        if (ag.status === "error" || ag.status === "cancelled" || /^\[Sub-agent (?:error|spawn error|denied|timeout)[^\]]*\]/.test(execResult)) {
          results.push(`${i + 1}. ${item.description}: ✗ error (${(ag.error || execResult.substring(0, 100))})`);
          allClean = false;
          // Reject: delete branch + worktree for failed items
          cleanupWorktree(root, execId, true);
          subAgents.delete(execId);
        } else {
          // Use a unique todoMatchKey for this execute item so progress is visible
          // Include a hash prefix to avoid collisions between items sharing the same first 50 chars
          const executeHash = createHash("sha1").update(item.description).digest("hex").substring(0, 8);
          const todoMatchKey = `execute:${executeHash}:${item.description.substring(0, 50)}`;
          const ir = await handleImproveMode(execId, ctxCwd, undefined, undefined, signal, todoMatchKey);
          results.push(`${i + 1}. ${item.description}: ${ir.clean ? "✅" : "⚠"} (${ir.iterations}r)`);
          if (!ir.clean) allClean = false;
          // Only auto-merge clean improvements — failed loops leave the branch for manual review
          if (ir.clean) {
            const mergeResult = autoMergeBranch(ctxCwd, execId, item.description);
            if (!mergeResult.retainForManualReview) {
              cleanupWorktree(root, execId, true);
              subAgents.delete(execId);
            }
          }
        }
      } else {
        results.push(`${i + 1}. ${item.description}: ✗ failed (no agent record)`);
        allClean = false;
        cleanupWorktree(root, execId, true);
        subAgents.delete(execId);
      }
    } catch (e: any) {
      const isAbort = signal?.aborted || (typeof e === "object" && e !== null && (e as any).name === "AbortError");
      const label = isAbort ? "cancelled" : "crashed";
      results.push(`${i + 1}. ${item.description}: ✗ ${label} (${(e.message || "").substring(0, 100)})`);
      allClean = false;
      // Kill the sub-agent process before cleaning up
      const ag = subAgents.get(execId);
      if (ag) {
        if (ag.status === "running") {
          // Set status to "cancelled" FIRST (before kill) so the closeHandler
          // sees the intended state and handles worktree cleanup via its
          // cancelled branch. This eliminates the TOCTOU race where the
          // closeHandler's commitWorktree (code===0) runs after we delete.
          ag.status = "cancelled";
          try { ag.proc?.kill("SIGKILL"); } catch { /* ok */ }
          // Worktree cleanup is handled by the closeHandler's cancelled branch
          // when the close event fires. Do NOT cleanup here to avoid racing
          // with commitWorktree in the code===0 branch.
        } else {
          // Agent is in a terminal state ("done", "error", "merged", etc.).
          // The closeHandler already ran and won't fire again. Clean up
          // the worktree and remove from map here to prevent leaks.
          cleanupWorktree(root, execId, true);
          subAgents.delete(execId);
        }
      }
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
    // When the process is killed by a signal, result.status is null and result.signal
    // contains the signal name (e.g., "SIGTERM", "SIGKILL"). Produce a descriptive message.
    const msg = result.signal
      ? `git ${args[0]} killed by ${result.signal}`
      : (result.stderr?.trim() || `git ${args[0]} exited with code ${result.status}`);
    const err: any = new Error(msg);
    err.stderr = result.stderr || "";
    err.stdout = result.stdout || "";
    err.status = result.status;
    err.signal = result.signal;
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

/** Commit changes in the worktree directly (run git from the worktree path, not the main repo).
 *  Returns the short commit hash on success, or empty string on failure.
 *  Callers should check for empty hash to detect failure. */
function commitWorktree(worktreePath: string, id: string, task: string): string {
  const truncated = [...task].slice(0, 80).join('');
  const msg = id ? `pi: ${id} — ${truncated}` : `pi: ${truncated}`;

  if (!worktreePath || !existsSync(join(worktreePath, ".git"))) return "";

  // Only commit changes in the sub-agent's worktree repo.
  // The extensions dir is a different git repo — do NOT commit unrelated changes there.
  if (!gitQuiet(["status", "--porcelain"], worktreePath).trim()) return "";

  let preCommitHash = "";
  try {
    // Capture the pre-commit HEAD hash so we can undo the commit on rev-parse failure.
    // This prevents duplicate commits if the caller retries after a false "failed" return.
    preCommitHash = git(["rev-parse", "HEAD"], worktreePath).trim();
    // Use git add -u (tracked files only) to avoid accidentally committing build
    // artifacts, large binaries, core dumps, logs, or secrets that the sub-agent
    // may have created. In a git worktree, the sub-agent should only modify
    // existing tracked files; new untracked files are intentionally excluded
    // from auto-commit as a security precaution.
    git(["add", "-u"], worktreePath);
    git(["commit", "-m", msg], worktreePath);
    const hash = git(["rev-parse", "--short", "HEAD"], worktreePath).trim();
    return hash;
  } catch (e: any) {
    // If commit succeeded but rev-parse failed, undo the commit to prevent duplicate commits
    // on caller retry. Only attempt undo if we have a valid pre-commit hash and commit likely
    // went through (add succeeded).
    try {
      const head = git(["rev-parse", "HEAD"], worktreePath).trim();
      if (head !== preCommitHash) {
        git(["reset", "--soft", "HEAD~1"], worktreePath);
      }
    } catch { /* best effort undo */ }
    // Reset the index to HEAD to prevent dirty staging area from leaking into the next
    // iteration. If `git add -u` succeeded but `git commit` failed, the index holds staged
    // changes. Without a reset, the next call's `git add -u` re-stages everything (no-op
    // for already-staged files), and a successful commit would bundle changes from *both*
    // iterations under a single message, losing the per-iteration audit trail.
    try { git(["reset", "HEAD"], worktreePath); } catch { /* best effort */ }
    console.error(`commitWorktree failed in ${worktreePath}: ${(e.message || e).substring(0, 200)}`);
    return "";
  }
}

/** Clean up worktree and optionally the branch */
function cleanupWorktree(projectRoot: string, id: string, deleteBranch: boolean): { branchDeleted: boolean; worktreeRemoved: boolean } {
  const safe = safeId(id);
  if (!safe) return { branchDeleted: false, worktreeRemoved: false }; // invalid id, nothing to clean up
  const wtDir = join(projectRoot, ".pi", "subagent", safe);
  const branch = branchName(id);
  let worktreeRemoved = false;
  let branchDeleted = false;
  // Remove git worktree metadata first
  try { git(["worktree", "remove", "--force", wtDir], projectRoot); worktreeRemoved = true; } catch { /* ok */ }
  // Always try to remove the directory — git worktree remove may leave stale dirs behind
  try { rmSync(wtDir, { recursive: true, force: true }); worktreeRemoved = true; } catch { /* ok */ }
  if (deleteBranch) {
    try { git(["branch", "-D", branch], projectRoot); branchDeleted = true; } catch { /* ok */ }
  }
  return { branchDeleted, worktreeRemoved };
}

// ── shared merge helper ─────────────────────────────────────────────────────

interface MergeBranchOptions {
  /** Policy for handling dirty working tree before merge */
  stashPolicy: "reject" | "auto";
  /** What to do when merge succeeds but commit fails */
  onCommitFailure: "abort-merge" | "keep-merge";
  /** Description for the auto-merge commit message */
  description: string;
}

interface MergeBranchResult {
  success: boolean;
  retainForManualReview: boolean;
  hasConflicts: boolean;
  conflictFiles: string;
  error?: string;
}

/**
 * Shared merge logic used by both autoMergeBranch (execute/improve) and
 * subagent_merge (manual tool). The two callers differ only in policy:
 * - autoMergeBranch: stashPolicy=auto, onCommitFailure=keep-merge
 * - subagent_merge:  stashPolicy=reject, onCommitFailure=abort-merge
 */
function mergeBranch(ctxCwd: string, execId: string, options: MergeBranchOptions): MergeBranchResult {
  const branch = branchName(execId);

  // Verify branch exists
  try { git(["rev-parse", "--verify", branch], ctxCwd); }
  catch { return { success: false, retainForManualReview: false, hasConflicts: false, conflictFiles: "", error: "Branch not found" }; }

  // Handle dirty working tree
  let stashed = false;
  const dirty = gitQuiet(["status", "--porcelain"], ctxCwd).trim();
  if (dirty) {
    if (options.stashPolicy === "reject") {
      return { success: false, retainForManualReview: false, hasConflicts: false, conflictFiles: "", error: "Dirty working tree" };
    }
    if (options.stashPolicy === "auto") {
      try {
        git(["stash", "push", "-m", `pi: auto-stash before merge ${execId}`], ctxCwd);
        stashed = true;
      } catch (e: any) {
        stashed = false;
        console.warn(`  \u26a0 git stash push failed before merge ${execId}: ${(e.message || "").substring(0, 80)}`);
      }
    }
  }

  // Attempt merge
  try {
    git(["merge", "--no-commit", "--no-ff", branch], ctxCwd);
  } catch (mergeErr: any) {
    const unmerged = gitQuiet(["ls-files", "-u"], ctxCwd).trim();
    const isConflict = unmerged.length > 0;
    gitQuiet(["merge", "--abort"], ctxCwd);
    if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { /* best effort */ } }
    if (isConflict) {
      const conflictFiles = gitQuiet(["diff", "--name-only", "--diff-filter=U"], ctxCwd);
      return { success: false, retainForManualReview: true, hasConflicts: true, conflictFiles, error: "Merge conflicts" };
    }
    return { success: false, retainForManualReview: false, hasConflicts: false, conflictFiles: "", error: (mergeErr as any).stderr || (mergeErr as any).message || "Unknown merge error" };
  }

  // Merge applied — commit
  try {
    git(["commit", "-m", `pi: merge ${execId}: ${options.description.substring(0, 60)}`, "--no-edit", "--allow-empty"], ctxCwd);
  } catch (commitErr: any) {
    if (options.onCommitFailure === "abort-merge") {
      gitQuiet(["merge", "--abort"], ctxCwd);
      if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { /* ok */ } }
      return { success: false, retainForManualReview: false, hasConflicts: false, conflictFiles: "", error: `Commit failed: ${(commitErr.message || "").substring(0, 200)}` };
    } else {
      // keep-merge: merge applied but commit failed — retain branch for manual review
      console.error(`  \u26a0 Merge of ${execId} applied but commit failed (${(commitErr.message || "").substring(0, 80)}). Branch retained for manual review.`);
      if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { /* ok */ } }
      return { success: false, retainForManualReview: true, hasConflicts: false, conflictFiles: "" };
    }
  }

  // Success
  if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { /* best effort */ } }
  return { success: true, retainForManualReview: false, hasConflicts: false, conflictFiles: "" };
}

// ── sub-process runner ───────────────────────────────────────────────────────

/** Run pi as a sub-process directly in a given directory (no worktree). */
function runSubProcess(task: string, cwd: string, model?: string, tools?: string, timeoutMs?: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const killTimeout = Math.max(timeoutMs || 1_200_000, 1_200_000); // default 20 min, floor 20 min
  const depth = currentDepth();
  return new Promise((resolve) => {
    const args: string[] = ["-p"];
    if (model) args.push("--model", model);
    if (tools) args.push("--tools", tools);
    args.push("\n" + task);
    const proc = spawn(resolvePiBin(), args, {
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
    let safetyTimer: NodeJS.Timeout | null = null;
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    let abortHandler: (() => void) | null = null;
    const done = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
        if (abortHandler && signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve({ stdout, stderr, exitCode });
      }
    };
    proc.on("close", (code) => {
      // Preserve -1 sentinel when timeout killed the process (don't overwrite with null from SIGTERM)
      if (exitCode !== -1) {
        exitCode = code;
      }
      done();
    });
    proc.on("error", (err: Error) => {
      stderr = `[spawn error] ${err.message}`;
      exitCode = -2;
      done();
    });

    // Wire up AbortSignal for mid-flight cancellation BEFORE early check to prevent race
    if (signal) {
      abortHandler = () => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        exitCode = -3;
        stderr = "[cancelled by user]";
        done();
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    // Early abort check — after attaching listener to prevent signal firing between check and listener
    if (signal?.aborted) {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      return void resolve({ stdout: "", stderr: "[cancelled]", exitCode: -3 });
    }

    const timer = setTimeout(() => {
      // Set exitCode sentinel BEFORE kill to prevent a race where the close event
      // fires between kill and the assignment, capturing the real exit code and
      // resolving the promise before exitCode = -1 takes effect.
      exitCode = -1;
      stderr = `[sub-process timeout after ${Math.round(killTimeout / 60_000)} min]`;
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
      // Schedule SIGKILL escalation after grace period
      // Don't call done() here — let the close event resolve the promise naturally
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null;
        try { proc.kill("SIGKILL"); } catch { /* ok */ }
        // Safety net: if close event still hasn't fired after SIGKILL, force-resolve
        safetyTimer = setTimeout(() => { if (!resolved) done(); }, 10_000);
      }, 10_000);
    }, killTimeout);
  });
}

// ── depth tracking ─────────────────────────────────────────────────────────

const MAX_DEPTH = 5;
const MAX_ROUNDS = 20;

function currentDepth(): number {
  const d = parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);
  return isNaN(d) ? 0 : Math.max(0, d);
}

/** Resolve the nearest git repo root from a starting directory. */
function resolveGitRoot(cwd: string): string {
  // Always check --git-common-dir first to detect worktree contexts.
  // In a regular repo it returns ".git" (relative); in a worktree it returns an
  // absolute path like /path/to/main/.git/worktrees/sa-xxx. Using this first ensures
  // we always resolve the main repo root, not a worktree root.
  try {
    const commonDir = git(["rev-parse", "--git-common-dir"], cwd).trim();
    if (commonDir === ".git") {
      // Regular repo (not a worktree). Use --show-toplevel to get the root.
      // This handles the common case and resolves symlinks correctly.
      return git(["rev-parse", "--show-toplevel"], cwd).trim();
    }
    // Worktree: strip /.git/worktrees/<name> suffix to get the main repo root
    return commonDir.replace(/\/\.git(?:\/worktrees\/[^\/]+)?$/, "");
  } catch {
    // Fallback: walk up looking for .git
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
    signal?: AbortSignal; // external cancellation signal
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

  // Reject empty/whitespace-only tasks immediately to avoid wasting resources
  if (!task || !task.trim()) {
    const errMsg = "Sub-agent task cannot be empty.";
    return {
      id: `sa-empty-task-${Date.now()}`,
      promise: Promise.resolve(`[Sub-agent denied] ${errMsg}`),
    };
  }

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
    projectRoot: root,
    task,
    status: "running",
    startTime,
    model: options?.model,
    tools: options?.tools,
  };
  subAgents.set(id, agent);

  // Create sentinel file so session_start can distinguish stale (interrupted)
  // agents from completed-but-unmerged ones. The sentinel is removed when the
  // agent reaches a terminal state.
  const sentinel = sentinelPath(root, id);
  if (sentinel) {
    try { writeFileSync(sentinel, String(process.pid), "utf-8"); } catch (e) {
      // Sentinel creation failure means orphaned worktrees won't be auto-cleaned on
      // next session_start. Log a warning so operators can detect and handle this.
      console.warn(`[subagent] failed to create sentinel ${sentinel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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

    const proc = spawn(resolvePiBin(), args, {
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
    let safetyTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout;

    const extSignal = options?.signal;
    let abortHandler: (() => void) | null = null;

    function settle(result: string, status: "done" | "error" | "cancelled") {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      proc.removeListener("close", closeHandler);
      proc.removeListener("error", errorHandler);
      if (abortHandler && extSignal) {
        extSignal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
      // Remove sentinel file — agent has reached terminal state
      try { if (sentinel) unlinkSync(sentinel); } catch { /* best effort */ }
      agent.status = status;
      agent.endTime = Date.now();
      resolve(result);
    }

    const closeHandler = (code: number | null) => {
      if (settled) return;
      // Note: agent may have been removed from subAgents map externally (TOCTOU race).
      // Always settle with the actual process output rather than checking the map,
      // which could race with external cleanup code.
      // Check cancelled FIRST: if external code cancelled the agent while the process
      // was still running, respect the cancellation even if the process later exits 0.
      // This prevents a TOCTOU race where the cancelled status is overwritten by a
      // simultaneous success exit.
      if (agent.status === "cancelled") {
        // Preserve the branch if the sub-agent exited successfully (code === 0). The
        // session_shutdown handler may have set status to "cancelled" before this close
        // event fired — without this guard, a successful commit would be nuked by the
        // branch deletion, losing the sub-agent's work.
        cleanupWorktree(root, id, code !== 0);
        settle("[Sub-agent cancelled]", "cancelled");
        return;
      }

      if (code === 0) {
        // TOCTOU guard: also check the external signal in case it fired moments before
        // this closeHandler ran but after agent.status was last checked.
        if (extSignal?.aborted) {
          agent.status = "cancelled";
          cleanupWorktree(root, id, true);
          settle("[Sub-agent cancelled]", "cancelled");
          return;
        }
        agent.result = stdout.trim();
        // Auto-commit changes made by the sub-agent
        agent.commitHash = commitWorktree(worktreePath, id, task);
        settle(stdout.trim(), "done");
        return;
      }

      if (code === null) {
        // Preserve timeout message if already set by killTimer (don't overwrite with generic signal message)
        if (!agent.error) {
          agent.error = stderr.trim() || "killed by signal";
        }
        cleanupWorktree(root, id, true);
        // Differentiate timeout (agent.error starts with "timeout") from signal kills
        const prefix = agent.error.startsWith("timeout") ? "[Sub-agent timeout]" : "[Sub-agent killed by signal]";
        settle(`${prefix} ${agent.error}\n\nOutput:\n${stdout.trim().substring(0, 3000)}`, "error");
      } else {
        agent.error = stderr.trim() || `exit code ${code}`;
        cleanupWorktree(root, id, true);
        settle(`[Sub-agent error (${code})] ${agent.error}\n\nOutput:\n${stdout.trim().substring(0, 3000)}`, "error");
      }
    };

    const errorHandler = (err: Error) => {
      agent.error = err.message;
      agent.status = "error";
      agent.endTime = Date.now();
      settle(`[Sub-agent spawn error] ${err.message}`, "error");
      cleanupWorktree(root, id, true);
    };

    proc.on("close", closeHandler);
    proc.on("error", errorHandler);

    // Wire up external AbortSignal for mid-flight cancellation
    if (extSignal) {
      abortHandler = () => {
        if (!settled && agent.status === "running") {
          agent.status = "cancelled";
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
          // closeHandler checks agent.status === "cancelled" and calls settle()
        }
      };
      extSignal.addEventListener("abort", abortHandler, { once: true });
    }

    // Kill process after timeout (min 20 min, configurable via options)
    const killTimeout = Math.max(options?.timeoutMs || 1_200_000, 1_200_000);
    killTimer = setTimeout(() => {
      if (agent.status === "running" && !settled) {
        // Escalation: SIGTERM → 10s grace → SIGKILL
        try { proc.kill("SIGTERM"); } catch { /* already dead */ }
        agent.error = `timeout (${Math.round(killTimeout / 60_000)} min)`;
        // Schedule SIGKILL escalation after grace period
        // Don't call settle() here — let the close event resolve the promise naturally
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null;
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
          // Safety net: if close event still hasn't fired after SIGKILL, force-settle
          safetyTimer = setTimeout(() => {
            safetyTimer = null;
            if (!settled) settle(`[Sub-agent timeout after ${Math.round(killTimeout / 60_000)} min]\n\nPartial:\n${stdout.trim().substring(0, 2000)}`, "error");
          }, 10_000);
        }, 10_000);
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
          try { ag.proc?.kill("SIGKILL"); } catch { /* already dead */ }
          // Wait for process to fully exit before cleaning up worktree to avoid
          // file handle races (e.g., rmSync on locked files after SIGKILL).
          // Attach the close listener BEFORE checking if the pid is alive to avoid
          // a TOCTOU race where the process exits between the check and the listener.
          if (ag.proc) {
            const { pid } = ag.proc;
            if (pid !== undefined) {
              const closePromise = new Promise<void>((resolveWait) => {
                const timeout = setTimeout(() => resolveWait(), 3000);
                ag.proc!.on("close", () => { clearTimeout(timeout); resolveWait(); });
              });
              try { process.kill(pid, 0); /* check if alive — wait for close */
                await closePromise;
              } catch { /* already dead */ }
            }
          }
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
      todoItems: Type.Optional(Type.String({ description: "JSON array of {description: string} (execute mode)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      refreshModels(); // pick up any model changes made mid-session

      // ── ANALYZE mode ────────────────────────────────────────────────
      if (params.mode === "analyze") {
        if (_signal?.aborted) return { content: [{ type: "text", text: "Cancelled by user." }], details: {} };
        const tb = (globalThis as any).__pi_todo;
        const taskHash = createHash("sha1").update(params.task).digest("hex").substring(0, 8);
        const todoMatchKey = `analyze:${taskHash}:${params.task.substring(0, 50)}`;
        if (tb) tb.addItem(`🔍 ${todoMatchKey}`);
        const result = await handleAnalyzeMode(params.task, ctx.cwd, _signal, todoMatchKey);
        if (tb) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "completed", `${result.clean ? "✅" : "⚠"} analyze: ${result.clean ? "clean" : result.iterations + " rounds"}`);
        return { content: [{ type: "text", text: result.summary }], details: { mode: "analyze", ...result } };
      }

      // ── IMPROVE mode ────────────────────────────────────────────────
      if (params.mode === "improve") {
        if (_signal?.aborted) return { content: [{ type: "text", text: "Cancelled by user." }], details: {} };
        // Add a todo item so progress is visible in the todo flow widget
        const tb = (globalThis as any).__pi_todo;
        // Use a unique match key incorporating the task text to avoid substring collisions
        const taskHash = createHash("sha1").update(params.task).digest("hex").substring(0, 8);
        const todoMatchKey = `improve:${taskHash}:${params.task.substring(0, 50)}`;
        if (tb) tb.addItem(`🔍 ${todoMatchKey}`);

        // If no subagentId, improve the current codebase directly (no worktree)
        // This avoids cross-repo mismatch when extensions live in a different git repo
        if (!params.subagentId) {
          const result = await handleImproveMode(null, ctx.cwd, params.criteria, params.task, _signal, todoMatchKey);
          if (tb) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "completed", `${result.clean ? "✅" : "⚠"} improve: ${result.clean ? "clean" : result.iterations + " rounds"}`);
          return { content: [{ type: "text", text: result.summary }], details: { mode: "improve", ...result } };
        }

        // If subagentId provided, improve the target sub-agent's worktree
        const result = await handleImproveMode(params.subagentId, ctx.cwd, params.criteria, undefined, _signal, todoMatchKey);
        if (tb) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "completed", `${result.clean ? "✅" : "⚠"} improve: ${result.clean ? "clean" : result.iterations + " rounds"}`);
        // Only auto-merge when the improve loop completed cleanly; failed loops leave the branch for review
        if (result.clean) {
          try {
            const ag = subAgents.get(params.subagentId);
            if (ag && ag.status !== "running") {
              const { retainForManualReview } = autoMergeBranch(
                ctx.cwd, params.subagentId,
                ag?.task || "delegated task"
              );
              if (!retainForManualReview) {
                cleanupWorktree(projectRoot(ctx.cwd), params.subagentId, true);
                subAgents.delete(params.subagentId);
              }
            } else if (!ag) {
              // Agent was evicted from map — reconstruct branch and merge anyway
              const safe = safeId(params.subagentId);
              if (safe) {
                const wtPath = join(projectRoot(ctx.cwd), ".pi", "subagent", safe);
                if (existsSync(wtPath)) {
                  const { retainForManualReview } = autoMergeBranch(
                    ctx.cwd, params.subagentId, "delegated task"
                  );
                  if (!retainForManualReview) {
                    cleanupWorktree(projectRoot(ctx.cwd), params.subagentId, true);
                  }
                }
              }
            }
          } catch { /* best effort cleanup */ }
        }
        return { content: [{ type: "text", text: result.summary }], details: { mode: "improve", ...result } };
      }

      // ── EXECUTE mode ────────────────────────────────────────────────
      if (params.mode === "execute") {
        if (_signal?.aborted) return { content: [{ type: "text", text: "Cancelled by user." }], details: {} };
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
        const result = await handleExecuteMode(items, ctx.cwd, _signal);
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
        if (_signal?.aborted) {
          return {
            content: [{ type: "text", text: `Wait for sub-agent ${params.id} was cancelled by user.` }],
            details: { status: ag.status },
          };
        }
        // Interruptible delay: resolve early if signal aborts to reduce cancellation latency
        await new Promise<void>((resolve) => {
          if (!_signal) return void setTimeout(resolve, 500);
          // Check pre-aborted: if signal already aborted, don't wait at all.
          // The event listener would never fire, forcing the full 500ms delay.
          if (_signal.aborted) return void resolve();
          const onAbort = () => { clearTimeout(timer); resolve(); };
          _signal.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(() => {
            _signal.removeEventListener("abort", onAbort);
            resolve();
          }, 500);
        });
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
      if (ag && ag.status === "running") return { content: [{ type: "text", text: `Sub-agent ${params.id} is still running. Wait for completion or cancel first.` }], details: {}, isError: true };

      // Use shared merge helper with policy: reject dirty tree, abort on commit failure
      const result = mergeBranch(ctx.cwd, params.id, {
        stashPolicy: "reject",
        onCommitFailure: "abort-merge",
        description: ag?.task || "delegated task",
      });

      if (!result.success) {
        if (result.error === "Dirty working tree") {
          return { content: [{ type: "text", text: "Working tree has uncommitted changes. Commit or stash before merging." }], details: {}, isError: true };
        }
        if (result.error === "Branch not found") {
          return { content: [{ type: "text", text: `Branch ${branch} for sub-agent ${params.id} not found. It may have been cleaned up already.` }], details: {}, isError: true };
        }
        if (result.hasConflicts) {
          return {
            content: [{
              type: "text",
              text: [
                `⚠ Merge conflicts detected for sub-agent ${params.id}`,
                `Branch: ${branch}`,
                "",
                "Conflicting files:",
                result.conflictFiles || "(check manually)",
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
        // Commit failure (abort-merge already handled inside mergeBranch)
        if (result.error?.startsWith("Commit failed:")) {
          return {
            content: [{
              type: "text",
              text: [
                `Merge of sub-agent ${params.id} failed during commit.`,
                `The merge has been aborted and working tree is clean.`,
                `Commit error: ${result.error.substring("Commit failed: ".length)}`,
                ``,
                `To retry: subagent_merge id="${params.id}"`,
              ].join("\n"),
            }],
            details: { merged: false, commitFailed: true, branch },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Merge failed for ${params.id}: ${result.error}` }],
          details: {},
          isError: true,
        };
      }

      // Success
      if (ag) ag.status = "merged";
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
      } catch (e: any) {
        // If JSON.parse fails, fall back to newline-delimited tasks
        if (!(e instanceof SyntaxError)) {
          console.error("subagent_parallel: JSON.parse threw non-SyntaxError", e);
          return { content: [{ type: "text", text: `Unexpected parse error: ${e.message}` }], details: {}, isError: true };
        }
        tasks = params.tasks.split("\n").filter((t: string) => t.trim());
      }
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks provided." }], details: {}, isError: true };
      }

      const maxCon = Math.max(Math.floor(params.maxConcurrency || 5), 1);
      const results: { task: string; id: string; result: string; status: string; elapsed: number; commitHash?: string }[] = [];

      for (let i = 0; i < tasks.length; i += maxCon) {
        if (_signal?.aborted) break;
        const batch = tasks.slice(i, i + maxCon);
        const batchIds: string[] = [];
        const batchPromises = batch.map((task) => {
          const { id, promise } = spawnSubAgent(task, ctx.cwd, {
            model: params.model,
            timeoutMs: params.timeoutMs,
            tools: params.tools ? params.tools.split(",") : undefined,
            systemPrompt: params.systemPrompt,
            signal: _signal,
          });
          batchIds.push(id);
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
        // spawnSubAgent promises always resolve (never reject), so Promise.all
        // cannot throw here. The .then() callback only reads properties and
        // never throws. No try/catch needed — dead code would silently mask
        // invariant violations.
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        // If cancelled mid-batch, clean up any sub-agents that are still tracked as running
        if (_signal?.aborted) {
          for (const id of batchIds) {
            const ag = subAgents.get(id);
            if (ag && ag.status === "running") {
              ag.status = "cancelled";
              try { ag.proc?.kill("SIGKILL"); } catch { /* ok */ }
              cleanupWorktree(projectRoot(ctx.cwd), id, true);
              subAgents.delete(id);
            }
          }
          break;
        }
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
      // Wait for process to fully exit before cleaning up worktree to avoid
      // file handle races (e.g., rmSync on locked files after SIGKILL).
      // Attach the close listener BEFORE checking if the pid is alive to avoid
      // a TOCTOU race where the process exits between the check and the listener.
      const { proc } = ag;
      if (proc) {
        const { pid } = proc;
        if (pid !== undefined) {
          const closePromise = new Promise<void>((resolveWait) => {
            const timeout = setTimeout(() => resolveWait(), 3000);
            proc.on("close", () => { clearTimeout(timeout); resolveWait(); });
          });
          try { process.kill(pid, 0); /* check if alive — wait for close */
            await closePromise;
          } catch { /* already dead */ }
        }
      }
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
  // ── session_start: recover from interrupted sessions ───────────────
  pi.on("session_start", async () => {
    // Clean up stale worktrees from previous interrupted sessions.
    // Only remove worktrees that still have a sentinel file — these are agents that
    // were interrupted (crashed/killed) before reaching a terminal state.
    // Completed-but-unmerged agents do NOT have sentinel files and are preserved.
    let root = process.env.PI_SUBAGENT_ROOT;
    if (!root) {
      // Fallback: resolve the git root from the current working directory.
      // This handles the common case where session_start runs in a pi session
      // that was started from a project directory (no PI_SUBAGENT_ROOT set).
      try {
        root = resolveGitRoot(process.cwd());
      } catch {
        // Can't determine project root — without PI_SUBAGENT_ROOT or a valid git
        // repository, we can't safely determine where worktrees live. Skip cleanup.
        return;
      }
    }
    const subDir = join(root, ".pi", "subagent");
    if (existsSync(subDir)) {
      try {
        const entries = readdirSync(subDir);
        for (const entry of entries) {
          // Skip non-directories and hidden files (like sentinel files)
          if (entry.startsWith(".")) continue;
          const wtDir = join(subDir, entry);
          // Verify the entry is a directory — regular files in .pi/subagent/ are not worktrees
          if (!lstatSync(wtDir).isDirectory()) continue;
          const sentinel = join(subDir, `.${entry}.sentinel`);
          // Only clean up if sentinel file still exists (agent was interrupted)
          if (!existsSync(sentinel)) continue;
          // Read PID from sentinel to avoid nuking worktrees of a still-running pi session.
          // If the PID is still alive, this sentinel belongs to a live process — skip it.
          try {
            const pidStr = readFileSync(sentinel, "utf-8").trim();
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
              try {
                process.kill(pid, 0);
                // PID is alive — verify it's actually a pi agent process, not a recycled PID
                // that happened to be reused by an unrelated process (PID-reuse TOCTOU).
                try {
                  const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
                  if (!cmdline.includes("pi")) {
                    // Not a pi process — sentinel is stale, proceed with cleanup
                    throw new Error("not pi");
                  }
                } catch {
                  // Can't read /proc/<pid>/cmdline (e.g., not on Linux, permissions error).
                  // Fall through and trust the kill check — the race window is small.
                }
                continue;
              } catch { /* dead, proceed with cleanup */ }
            }
          } catch { /* can't read sentinel, treat as stale and clean up */ }
          const branch = `pi/subagent/${entry}`;
          try {
            git(["worktree", "remove", "--force", wtDir], root);
            git(["branch", "-D", branch], root);
            // Only remove sentinel after both git operations succeed — if either fails,
            // the sentinel remains so the next session_start retries cleanup.
            unlinkSync(sentinel);
          } catch { /* best effort — may have been partially cleaned */ }
        }
      } catch { /* ok */ }
    }
  });

  pi.on("session_shutdown", async () => {
    for (const [id, ag] of subAgents) {
      ag.status = "cancelled";
      try { ag.proc?.kill("SIGKILL"); } catch { /* process may have already exited */ }
    }
    // Don't auto-cleanup worktrees — they contain committed work that may be valuable
    subAgents.clear();
  });
}
