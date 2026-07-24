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
  status: "running" | "done" | "error" | "cancelled" | "merged" | "rejected" | "improving";
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  proc?: ChildProcess;
  model?: string;
  tools?: string[];
  commitHash?: string;
  /** Set to true when git commit fails in the close handler (structured alternative to string matching) */
  commitFailed?: boolean;
}

const subAgents = new Map<string, SubAgent>();

/** Eviction age: terminal-state agents older than this are auto-removed from the map */
const EVICTION_AGE_MS = 10 * 60 * 1000; // 10 minutes

/** Throttle eviction calls to avoid excessive filesystem I/O */
let _lastEvictTime = 0;
const EVICT_THROTTLE_MS = 10_000;

/** Shared prefix for commit-failure errors in mergeBranch — kept as a constant so consumers can strip it reliably */
const COMMIT_FAILED_PREFIX = "Commit failed: ";

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
            // Delete the git branch FIRST to avoid orphan branches — the branch delete
            // uses the worktree path as CWD, which won't exist after rmSync.
            try { gitQuiet(["branch", "-D", branchName(ag.id)], ag.worktreePath); } catch { /* ok */ }
            try { rmSync(ag.worktreePath, { recursive: true, force: true }); } catch { /* ok */ }
          }
        } catch {
          try { gitQuiet(["branch", "-D", branchName(ag.id)], ag.worktreePath); } catch { /* ok */ }
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
  // Allow alphanumeric, dash, underscore. Replace anything else.
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  if (cleaned.length === 0 || cleaned.length > 71) return null;
  const hash = createHash("sha1").update(raw).digest("hex").substring(0, 8);
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
    console.warn("subagent: failed to load settings.json", e.message);
  }
}

refreshModels();

function branchName(id: string, safe?: string | null): string {
  const s = safe ?? safeId(id);
  if (!s) {
    // Fallback: hash the raw id to produce a stable, safe branch component
    const hash = createHash("sha1").update(id).digest("hex").substring(0, 12);
    return `pi/subagent/fallback-${hash}`;
  }
  return `pi/subagent/${s}`;
}

// ── Todo bridge helper ───────────────────────────────────────────────────────

function getTodoBridge(): any {
  return (globalThis as any).__pi_todo;
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
  workCwd: string,
  buildReviewTask: (i: number) => string,
  runAction: (issuesCount: number, reviewerOutput: string, i: number) => Promise<string>,
  commitPrefix = "loop",
  signal?: AbortSignal,
  todoMatchKey?: string, // unique key for todo bridge updates (avoids substring collisions)
  model?: string // model override for reviewer
): Promise<LoopResult> {
  const iterations: { iter: number; issuesFound: number; clean: boolean }[] = [];

  const loopStartTime = Date.now();
  for (let i = 1; i <= MAX_ROUNDS; i++) {
    if (signal?.aborted) return { iterations: i, clean: false, summary: "❌ Cancelled by user during review loop." };
    if (Date.now() - loopStartTime > MAX_LOOP_DURATION_MS) {
      return { iterations: i - 1, clean: false, summary: `❌ Overall review loop deadline (${(MAX_LOOP_DURATION_MS / 1000).toFixed(0)}s) exceeded at round ${i}.` };
    }
    // Update todo progress if bridge available
    const tb = getTodoBridge();
    if (tb && todoMatchKey) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "in_progress", `🔍 improve round ${i}/${MAX_ROUNDS}: reviewing...`);

    // Throttle evictTerminalAgents to avoid filesystem I/O on every loop iteration
    if (Date.now() - _lastEvictTime >= EVICT_THROTTLE_MS) {
      evictTerminalAgents();
      _lastEvictTime = Date.now();
    }
    const reviewTask = buildReviewTask(i);
    // Reviewer runs directly (no worktree) — it only reads and reports
    let r;
    // runSubProcess always resolves (never rejects on its own). The try/catch
    // only handles the edge case where resolvePiBin() throws synchronously
    // inside the Promise constructor (e.g., missing binary).
    try {
      r = await runSubProcess(reviewTask, workCwd, model ?? _defaultModel, "read,bash,serena_search_pattern,serena_overview", undefined, signal);
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
    if (/^\[Sub-agent (?:error|spawn error|denied|timeout|commit failed|killed by signal)[^\]]*\]/.test(fixerOutput)) {
      return { iterations: i, clean: false, summary: `❌ Fixer failed at round ${i}: ${fixerOutput.substring(0, 200)}` };
    }
    if (commitPrefix !== "") {
      const hash = commitWorktree(workCwd, commitPrefix, `iteration ${i}: ${actualIssuesCount} ${actualIssuesCount === 1 ? 'issue' : 'issues'}`);
      if (hash === "no-changes") {
        // No changes to commit — the fixer correctly determined no modifications
        // were needed (e.g., false positive review). Continue the loop.
      } else if (!hash) {
        console.error(`reviewLoop: commitWorktree failed at iteration ${i} in ${workCwd}`);
        // Reset the worktree to prevent residual uncommitted changes from leaking
        // into the next iteration. The fixer's changes remain uncommitted; if the
        // caller retries the improve loop, a clean review round would start fresh.
        try { gitQuiet(["checkout", "--", "."], workCwd); } catch { /* best effort */ }
        try { gitQuiet(["clean", "-fd"], workCwd); } catch { /* best effort */ }
        return { iterations: i, clean: false, summary: `❌ Fix applied but git commit failed at round ${i}. Aborting to avoid stale state.` };
      }
    }
  }

  // Finalize todo item when MAX_ROUNDS reached (non-clean exit)
  const tb = getTodoBridge();
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
async function handleAnalyzeMode(task: string, ctxCwd: string, signal?: AbortSignal, todoMatchKey?: string, model?: string): Promise<LoopResult> {
  // Phase 1: initial exploration with cheap model (use sub-process, not worktree)
  const initTask = `Explore and analyze: ${task}\n\nBe thorough. DO NOT modify any files. Produce a comprehensive analysis.`;
  // If _cheapModel is undefined (refreshModels failed or no cheap model configured),
  // derive a fallback from _defaultModel or log a warning.
  const cheapModel = _cheapModel ?? (_defaultModel ? _defaultModel.replace(/pro/i, "flash") : undefined);
  if (!cheapModel) console.warn("handleAnalyzeMode: _cheapModel is undefined and no fallback could be derived; using system default.");
  let initR;
  try {
    initR = await runSubProcess(initTask, ctxCwd, cheapModel, "read,bash,serena_search_pattern,serena_overview", undefined, signal);
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
    ctxCwd,
    (_i) => [
      `Review this analysis. Identify gaps, inaccuracies, or missing details.`,
      `--- ANALYSIS ---`, analysis.substring(0, 24000), `--- END ---`,
      `FOUND: <number>`, `CLEAN: <true|false>`, `ISSUES:`,
      `- <issue>`,
      `If CLEAN: true, just write "CLEAN: true".`,
    ].join("\n"),
    async (_c, reviewerOutput, _i) => {
      // Check for cancellation before running the fixer to avoid wasted work
      if (signal?.aborted) {
        return "[cancelled by user]";
      }
      const r = await runSubProcess(
        `Improve this analysis based on feedback. Produce a complete final analysis. DO NOT modify files.\n\n` +
        `Feedback: ${reviewerOutput.substring(0, 4000)}`,
        ctxCwd,
        model ?? _defaultModel,
        "read,bash,serena_search_pattern,serena_overview",
        undefined,
        signal
      );
      // Check if the fixer was cancelled/aborted mid-execution before trusting its output
      if (signal?.aborted || r.exitCode === -3) {
        return "[cancelled by user]";
      }
      const improved = r.stdout + (r.stderr ? "\n" + r.stderr : "");
      if (improved.trim().length > 0) analysis = improved; // update for next review round
      // Non-zero exit code means the sub-process crashed or failed mid-way — don't trust partial output.
      if (r.exitCode !== 0) {
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
  todoMatchKey?: string, // unique key for todo bridge updates
  model?: string // model override for the fixer sub-process
): Promise<LoopResult> {
  // Early cancellation check before any filesystem or validation work
  if (signal?.aborted) {
    return { iterations: 0, clean: false, summary: "❌ Cancelled by user before starting improvement." };
  }

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
      // Verify it's a valid git worktree (contains .git file or .git directory)
      if (!existsSync(join(reconstructed, ".git"))) {
        return { iterations: 0, clean: false, summary: `Sub-agent ${targetAgentId} worktree ${reconstructed} is not a valid git worktree (missing .git).` };
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

  // Preserve agent status during improve loop so evictTerminalAgents doesn't
  // delete the worktree out from under the active review loop.
  const originalStatus = existing?.status;
  if (existing && originalStatus && ["done", "error", "merged", "rejected", "cancelled"].includes(originalStatus)) {
    existing.status = "improving";
  }

  let _loopResult: LoopResult = { iterations: 0, clean: false, summary: "Unexpected error in review loop" };
  try {
    _loopResult = await reviewLoop(
      workCwd,
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
        // Check for cancellation before running the fixer to avoid wasted work
        if (signal?.aborted) {
          return "[cancelled by user]";
        }
        // Fixer runs directly in the target worktree (no merge needed)
        // reviewLoop handles committing (via commitWorktree) after each fixer round when
        // commitPrefix is non-empty (i.e., when working in a sub-agent worktree).
        // For direct codebase improvement (no targetAgentId), changes are not auto-committed.
        const fixerTask = `Fix ${issuesCount} ${issuesCount === 1 ? 'issue' : 'issues'}:\n\n${reviewerOutput.substring(0, 4000)}\n\nMake concrete edits to the files.`;
        const r = await runSubProcess(fixerTask, workCwd, model ?? _defaultModel, "read,edit,write,bash,serena_search_pattern,serena_overview", undefined, signal);
        const output = r.stdout + (r.stderr ? "\n[stderr]\n" + r.stderr : "");
        // Check if the fixer was cancelled/aborted mid-execution before trusting its output
        if (signal?.aborted || r.exitCode === -3) {
          return "[cancelled by user]";
        }
        // Non-zero exit code means the sub-process crashed or failed mid-way — don't trust partial output.
        if (r.exitCode !== 0) {
          return `[Sub-agent error] Fixer process failed (exit ${r.exitCode}): ${output.substring(0, 200)}`;
        }
        return output;
      },
      targetAgentId ? `improve-${safeId(targetAgentId) || "unknown"}` : "",
      signal,
      todoMatchKey
    );
  } finally {
    // Restore original status after loop completes so evictTerminalAgents
    // can resume normal eviction for this agent.
    if (existing && originalStatus) {
      existing.status = originalStatus;
    }
  }
  return _loopResult;
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
  if (!result.success && result.error && result.error !== "Branch not found" && !result.error.includes("Already up to date")) {
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
        if (ag.status === "error" || ag.status === "cancelled" || /^\[Sub-agent (?:error|spawn error|denied|timeout|commit failed|killed by signal)[^\]]*\]/.test(execResult)) {
          results.push(`${i + 1}. ${item.description}: ✗ error (${(ag.error || execResult.substring(0, 100))})`);
          allClean = false;
          // Preserve worktree and branch for commit failures so the user can inspect
          // and manually commit the changes (the error message tells them to check the worktree).
          const isCommitFailure = ag.commitFailed === true;
          cleanupWorktree(root, execId, !isCommitFailure);
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
        // Agent was evicted from map (terminal state + age > EVICTION_AGE_MS).
        // Check if the branch has unmerged commits to distinguish "actually failed"
        // from "evicted-but-done" — a completed agent may have been evicted during
        // a long-running execute pipeline.
        const branch = branchName(execId);
        let branchExists = true;
        let hasUnmergedCommits = false;
        try {
          const mergeBase = git(["merge-base", branch, "HEAD"], root).trim();
          const branchTip = git(["rev-parse", branch], root).trim();
          hasUnmergedCommits = mergeBase !== branchTip;
        } catch {
          // git merge-base or rev-parse threw — branch was already deleted (merged and cleaned up)
          branchExists = false;
        }
        if (branchExists && hasUnmergedCommits) {
          results.push(`${i + 1}. ${item.description}: ⚠ evicted but had committed work (branch preserved)`);
        } else if (branchExists) {
          // Branch exists but has no unmerged commits — agent either completed
          // with no changes ("no-changes" from commitWorktree) or was already
          // merged. Either way this is not a failure.
          results.push(`${i + 1}. ${item.description}: ✅ completed (no uncommitted changes)`);
        } else {
          // Branch doesn't exist at all → already merged and cleaned up, report as completed
          results.push(`${i + 1}. ${item.description}: ✅ already merged (evicted)`);
        }
        cleanupWorktree(root, execId, branchExists && !hasUnmergedCommits);
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
        // Save the pre-cancellation status BEFORE overwriting it, so closeHandler
        // sees our intended state and we can decide branch preservation below.
        // Setting status FIRST closes the TOCTOU window where closeHandler could
        // commitWorktree (code===0) between our running-check and the kill.
        const prevStatus = ag.status;
        ag.status = "cancelled";

        if (prevStatus === "running") {
          try { ag.proc?.kill("SIGKILL"); } catch { /* ok */ }
          // closeHandler will fire (or already fired). If it saw "cancelled" (because
          // we set it before kill), it will call cleanupWorktree with (code !== 0)
          // and settle. If it fired in the narrow window before our status write, it
          // would have committed the work. cleanupWorktree is idempotent, so calling
          // it here is safe regardless — double-cleanup is a no-op.
          cleanupWorktree(root, execId, true);
          subAgents.delete(execId);
        } else {
          // Agent was already in a terminal state ("done", "error", "merged", etc.).
          // Preserve the git branch if the work was already committed.
          const deleteBranch = prevStatus !== "done" && prevStatus !== "merged";
          cleanupWorktree(root, execId, deleteBranch);
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
        // Attempt recovery: if basic git commands work, the failure was transient.
        // Use `git status --porcelain` instead of `git symbolic-ref HEAD` because
        // a detached HEAD is a perfectly valid repo state — symbolic-ref would fail
        // and trigger an unnecessary destructive re-init.
        try {
          git(["status", "--porcelain"], projectRoot);
          return projectRoot;
        } catch {
          // Both rev-parse and status failed — repo is unusable. Force-remove.
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
  const branch = branchName(id, safe);
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
  catch {
    git(["commit", "-m", "pi: placeholder", "--allow-empty"], projectRoot);
    try { headRef = git(["rev-parse", "--verify", "HEAD"], projectRoot).trim(); }
    catch (e: any) { throw new Error(`Failed to resolve HEAD after placeholder commit: ${e.stderr || e.message}`); }
  }

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
 *  Returns the short commit hash on success.
 *  Returns "no-changes" if the worktree has no uncommitted changes (caller should treat as skip).
 *  Returns "" on failure (git add/commit error, or hash retrieval failure).
 *  Callers: check for empty string to detect failure, check for "no-changes" to skip. */
function commitWorktree(worktreePath: string, id: string, task: string): string {
  // Use Intl.Segmenter for grapheme-cluster-aware truncation (avoids splitting combining characters).
  // Fall back to code-point spread if Segmenter is unavailable (e.g., older Node.js).
  let truncated: string;
  try {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const segments = [...segmenter.segment(task)].slice(0, 80);
    truncated = segments.map(s => s.segment).join('');
  } catch {
    truncated = [...task].slice(0, 80).join('');
  }
  // Guard against empty truncated message (e.g., task consisting entirely of zero-width characters)
  if (!truncated || !truncated.trim()) truncated = "(empty task)";
  const msg = id ? `pi: ${id} — ${truncated}` : `pi: ${truncated}`;

  if (!worktreePath || !existsSync(join(worktreePath, ".git"))) return "";

  // Only commit changes in the sub-agent's worktree repo.
  // The extensions dir is a different git repo — do NOT commit unrelated changes there.
  if (!gitQuiet(["status", "--porcelain"], worktreePath).trim()) return "no-changes";

  try {
    // Use git add -A to stage all changes including new files the sub-agent may
    // have created via the write tool. The .gitignore file still excludes build
    // artifacts, binaries, logs, and secrets; -A is safe because the worktree
    // is dedicated to this sub-agent's task and should reflect the full diff.
    git(["add", "-A"], worktreePath);
    git(["commit", "-m", msg], worktreePath);
    // git commit succeeded. Attempt hash retrieval — if rev-parse fails we still
    // return a success indicator rather than undoing the commit (which would
    // create a false negative for the caller).
    try {
      return git(["rev-parse", "--short", "HEAD"], worktreePath).trim();
    } catch {
      const fullHash = gitQuiet(["rev-parse", "HEAD"], worktreePath).trim();
      if (fullHash) return fullHash.substring(0, 7);
      console.warn(`commitWorktree: commit succeeded but rev-parse HEAD failed in ${worktreePath}; hash unknown.`);
      return "committed-no-hash";
    }
  } catch (e: any) {
    // git add or git commit failed. Reset the index to prevent dirty staging area
    // from leaking into the next iteration. If `git add -A` succeeded but
    // `git commit` failed, the index holds staged changes. Without a reset, the
    // next call's `git add -A` re-stages everything (no-op for already-staged
    // files), and a successful commit would bundle changes from *both* iterations
    // under a single message, losing the per-iteration audit trail.
    try { git(["reset", "HEAD"], worktreePath); } catch (resetErr: any) {
      console.error(`commitWorktree: git reset HEAD also failed in ${worktreePath}: ${(resetErr.message || resetErr).substring(0, 200)}`);
    }
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
        git(["stash", "push", "--include-untracked", "-m", `pi: auto-stash before merge ${execId}`], ctxCwd);
        stashed = true;
      } catch (e: any) {
        console.warn(`  \u26a0 git stash push failed before merge ${execId}: ${(e.message || "").substring(0, 80)}`);
        // Stash-push failure means the working tree could not be stashed, so
        // the merge cannot proceed. Return retainForManualReview: true so the
        // sub-agent's branch is preserved for manual merge instead of being deleted.
        return { success: false, retainForManualReview: true, hasConflicts: false, conflictFiles: "", error: `git stash push failed: ${(e.message || "").substring(0, 80)}` };
      }
    }
  }

  // Attempt merge
  try {
    git(["merge", "--no-commit", "--no-ff", branch], ctxCwd);
  } catch (mergeErr: any) {
    const unmerged = gitQuiet(["ls-files", "-u"], ctxCwd).trim();
    const isConflict = unmerged.length > 0;
    // Parse unique filenames from ls-files -u output BEFORE abort (which clears conflict state)
    let conflictFiles = "";
    if (isConflict) {
      const seen = new Set<string>();
      for (const line of unmerged.split('\n')) {
        const tabIdx = line.indexOf('\t');
        if (tabIdx >= 0) {
          const path = line.substring(tabIdx + 1);
          if (path) seen.add(path);
        }
      }
      conflictFiles = [...seen].join('\n');
    }
    gitQuiet(["merge", "--abort"], ctxCwd);
    if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { console.warn(`  \u26a0 git stash pop failed after merge conflict \u2014 stashed changes remain in stash for ${execId}. Use "git stash pop" manually.`); } }
    if (isConflict) {
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
      if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { console.warn(`  \u26a0 git stash pop failed after abort-merge \u2014 stashed changes remain in stash for ${execId}. Use "git stash pop" manually.`); } }
      return { success: false, retainForManualReview: false, hasConflicts: false, conflictFiles: "", error: `${COMMIT_FAILED_PREFIX}${(commitErr.message || "").substring(0, 200)}` };
    } else {
      // keep-merge: merge applied but commit failed — retain branch for manual review
      console.error(`  \u26a0 Merge of ${execId} applied but commit failed (${(commitErr.message || "").substring(0, 80)}). Branch retained for manual review.`);
      if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { console.warn(`  \u26a0 git stash pop failed after keep-merge \u2014 stashed changes remain in stash for ${execId}. Use "git stash pop" manually.`); } }
      return { success: false, retainForManualReview: true, hasConflicts: false, conflictFiles: "" };
    }
  }

  // Success
  if (stashed) { try { git(["stash", "pop"], ctxCwd); } catch { console.warn(`  \u26a0 git stash pop failed after successful merge \u2014 stashed changes remain in stash for ${execId}. Use "git stash pop" manually.`); } }
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
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    let abortHandler: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    const done = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
        if (abortHandler && signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        proc.removeListener("close", closeHandler);
        proc.removeListener("error", errorHandler);
        resolve({ stdout, stderr, exitCode });
      }
    };
    const closeHandler = (code: number | null) => {
      // Trust the real exit code whenever we have one, regardless of timeout timeline.
      // When the timeout fires and kills the process, code will be null (SIGTERM/SIGKILL)
      // and exitCode stays -1 (set by the timeout handler), which is the correct sentinel.
      // When the process exits naturally (non-null) concurrent with the timer, trust the real exit code.
      if (code !== null) {
        exitCode = code;
      }
      // else: timedOut && code===null → keep exitCode=-1 (set by timeout handler)
      done();
    };
    const errorHandler = (err: Error) => {
      stderr = `[spawn error] ${err.message}`;
      exitCode = -2;
      done();
    };
    proc.on("close", closeHandler);
    proc.on("error", errorHandler);

    // Wire up AbortSignal for mid-flight cancellation BEFORE early check to prevent race
    if (signal) {
      abortHandler = () => {
        // If the process already exited (proc.exitCode set) before close event,
        // let the closeHandler report the real exit code instead of overwriting it.
        if (proc.exitCode !== null) return;
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        exitCode = -3;
        stderr = "[cancelled by user]";
        done();
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    // Early abort check — after attaching listener to prevent signal firing between check and listener
    if (signal?.aborted) {
      // If the process already exited, let closeHandler handle it
      if (proc.exitCode !== null) { done(); return; }
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      stderr = "[cancelled]";
      exitCode = -3;
      done(); // Call done() to clean up timers and listeners, not raw resolve()
      return;
    }

    timer = setTimeout(() => {
      // Use a separate timedOut flag instead of setting exitCode = -1 as a sentinel.
      // This avoids a race where the process exits naturally with code 0 between the
      // assignment and the close handler firing, permanently masking the real exit code.
      timedOut = true;
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
const MAX_LOOP_DURATION_MS = 180_000; // 3-minute absolute deadline for the entire review loop

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
    try { writeFileSync(sentinel, `${process.pid}\n${Date.now()}`, "utf-8"); } catch (e) {
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

    let proc: ChildProcess;
    try {
      proc = spawn(resolvePiBin(), args, {
        cwd: worktreePath,
        env: {
          ...process.env,
          PI_SUBAGENT_DEPTH: String(depth + 1),
          PI_SUBAGENT_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      // Clean up sentinel if spawn threw synchronously before event handlers were attached.
      // Without this, the sentinel would persist until the next session_start, potentially
      // confusing startup cleanup logic.
      try { if (sentinel) unlinkSync(sentinel); } catch { /* best effort */ }
      // Clean up the worktree since the sub-agent process never started
      cleanupWorktree(root, id, true);
      agent.error = `spawn failed: ${(err.message || err).substring(0, 200)}`;
      agent.status = "error";
      agent.endTime = Date.now();
      resolve(`[Sub-agent spawn error] ${agent.error}`);
      return;
    }
    agent.proc = proc;

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const extSignal = options?.signal;
    let abortHandler: (() => void) | null = null;

    function settle(result: string, status: "done" | "error" | "cancelled") {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
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

    // Kill process after timeout (min 20 min, configurable via options).
    // Declared before closeHandler so the function can reference it without
    // a temporal-dead-zone dependency.
    const killTimeout = Math.max(options?.timeoutMs || 1_200_000, 1_200_000);

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
        // If the process actually exited successfully (code 0), commit the work before
        // cleaning up, even though the agent was cancelled. The session_shutdown handler
        // may have set status to "cancelled" between process exit and this close event,
        // and without this commit the sub-agent's completed work would be silently lost.
        if (code === 0) {
          const ch = commitWorktree(worktreePath, id, task);
          if (ch && ch !== "no-changes") agent.commitHash = ch === "committed-no-hash" ? "(hash unknown)" : ch;
        }
        cleanupWorktree(root, id, code !== 0);
        settle("[Sub-agent cancelled]", "cancelled");
        return;
      }

      if (code === 0) {
        agent.result = stdout.trim();
        // Auto-commit changes made by the sub-agent
        const ch = commitWorktree(worktreePath, id, task);
        if (ch === "") {
          agent.commitFailed = true;
          agent.error = "Sub-agent completed but git commit failed. Check worktree for uncommitted work.";
          settle(`[Sub-agent commit failed]\n${stdout.trim()}\n\nSub-agent completed but could not commit changes to git. The worktree at ${worktreePath} may contain uncommitted work.`, "error");
          return;
        }
        agent.commitHash = ch === "no-changes" ? "" : ch === "committed-no-hash" ? "(hash unknown)" : ch;
        settle(stdout.trim(), "done");
        return;
      }

      if (code === null) {
        // Use the timedOut flag (set by killTimer) to classify the signal, not string matching
        // on agent.error. This avoids misclassifying stderr output that happens to start with
        // "timeout" (e.g., test runner output).
        if (timedOut) {
          agent.error = agent.error || `timeout (${Math.round(killTimeout / 60_000)} min)`;
        } else {
          agent.error = stderr.trim() || "killed by signal";
        }
        cleanupWorktree(root, id, true);
        const prefix = timedOut ? "[Sub-agent timeout]" : "[Sub-agent killed by signal]";
        settle(`${prefix} ${agent.error}\n\nOutput:\n${stdout.trim().substring(0, 3000)}`, "error");
      } else {
        agent.error = stderr.trim() || `exit code ${code}`;
        cleanupWorktree(root, id, true);
        settle(`[Sub-agent error (${code})] ${agent.error}\n\nOutput:\n${stdout.trim().substring(0, 3000)}`, "error");
      }
    };

    const errorHandler = (err: Error) => {
      if (settled) return;
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
        // Only cancel if the process is still running (exitCode === null).
        // If proc.exitCode is already set (e.g., 0 for successful exit) but closeHandler
        // hasn't fired yet, don't overwrite — let closeHandler report the real result.
        if (!settled && agent.status === "running" && proc.exitCode === null) {
          agent.status = "cancelled";
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
          // closeHandler checks agent.status === "cancelled" and calls settle()
        }
      };
      extSignal.addEventListener("abort", abortHandler, { once: true });
    }
    // Early abort check after attaching listener to prevent signal firing between check and listener
    if (extSignal?.aborted) {
      if (!settled && agent.status === "running" && proc.exitCode === null) {
        agent.status = "cancelled";
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        // closeHandler checks agent.status === "cancelled" and calls settle()
      }
    }

    killTimer = setTimeout(() => {
      if (agent.status === "running" && !settled) {
        // Use a boolean flag to indicate timeout, not a string sentinel in agent.error.
        // The closeHandler checks this flag to classify signal kills vs. timeouts,
        // avoiding a fragile startsWith("timeout") check on possibly-user-generated stderr.
        timedOut = true;
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
          refreshModels(); // pick up any model changes made mid-session
          const { id } = spawnSubAgent(rest, ctx.cwd);
          ctx.ui.notify(`Sub-agent ${id} spawned (worktree: .pi/subagent/${id})`, "info");
          return;
        }
        case "list": {
          if (subAgents.size === 0) { ctx.ui.notify("No sub-agents running.", "info"); return; }
          const lines = ["Sub-agents:"];
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
          // Wait for process to fully exit before cleaning up worktree to avoid
          // file handle races (e.g., rmSync on locked files after SIGKILL).
          // Attach the close listener BEFORE killing and checking if the pid is
          // alive to avoid a TOCTOU race where the process exits between the
          // check and the listener.
          if (ag.proc) {
            const { pid } = ag.proc;
            if (pid !== undefined) {
              const closePromise = new Promise<void>((resolveWait) => {
                const timeout = setTimeout(() => resolveWait(), 3000);
                ag.proc!.on("close", () => { clearTimeout(timeout); resolveWait(); });
              });
              try { ag.proc!.kill("SIGKILL"); } catch { /* already dead */ }
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
        const tb = getTodoBridge();
        const taskHash = createHash("sha1").update(params.task).digest("hex").substring(0, 8);
        const todoMatchKey = `analyze:${taskHash}:${params.task.substring(0, 50)}`;
        if (tb) tb.addItem(`🔍 ${todoMatchKey}`);
        const result = await handleAnalyzeMode(params.task, ctx.cwd, _signal, todoMatchKey, params.model);
        if (tb) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "completed", `${result.clean ? "✅" : "⚠"} analyze: ${result.clean ? "clean" : result.iterations + " rounds"}`);
        return { content: [{ type: "text", text: result.summary }], details: { mode: "analyze", ...result } };
      }

      // ── IMPROVE mode ────────────────────────────────────────────────
      if (params.mode === "improve") {
        if (_signal?.aborted) return { content: [{ type: "text", text: "Cancelled by user." }], details: {} };
        // Add a todo item so progress is visible in the todo flow widget
        const tb = getTodoBridge();
        // Use a unique match key incorporating the task text to avoid substring collisions
        const taskHash = createHash("sha1").update(params.task).digest("hex").substring(0, 8);
        const todoMatchKey = `improve:${taskHash}:${params.task.substring(0, 50)}`;
        if (tb) tb.addItem(`🔍 ${todoMatchKey}`);

        // If no subagentId, improve the current codebase directly (no worktree)
        // This avoids cross-repo mismatch when extensions live in a different git repo
        // Treat undefined, null, empty, or whitespace-only as "no subagentId"
        if (params.subagentId === undefined || params.subagentId === null || params.subagentId.trim() === "") {
          const result = await handleImproveMode(null, ctx.cwd, params.criteria, params.task, _signal, todoMatchKey, params.model);
          if (tb) tb.updateItemByContent(`🔍 ${todoMatchKey}`, "completed", `${result.clean ? "✅" : "⚠"} improve: ${result.clean ? "clean" : result.iterations + " rounds"}`);
          return { content: [{ type: "text", text: result.summary }], details: { mode: "improve", ...result } };
        }

        // If subagentId provided, improve the target sub-agent's worktree
        const result = await handleImproveMode(params.subagentId, ctx.cwd, params.criteria, undefined, _signal, todoMatchKey, params.model);
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
              // Agent was evicted from map — reconstruct branch and merge anyway.
              // evictTerminalAgents removes the worktree directory for "done" agents
              // but preserves the git branch. Check branch existence instead of the
              // worktree directory so we don't skip the merge.
              const safe = safeId(params.subagentId);
              if (safe) {
                const branch = branchName(params.subagentId);
                let branchExists = false;
                try {
                  git(["rev-parse", "--verify", branch], projectRoot(ctx.cwd));
                  branchExists = true;
                } catch { /* branch doesn't exist — nothing to merge */ }
                if (branchExists) {
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ag = subAgents.get(params.id);
      if (!ag) {
        // Recovery: the agent may have been evicted from the map but the git branch
        // and worktree still exist. Check the branch to provide a helpful message.
        try {
          const branch = branchName(params.id);
          const root = projectRoot(ctx?.cwd || process.cwd());
          git(["rev-parse", "--verify", branch], root);
          return {
            content: [{ type: "text", text: `Sub-agent ${params.id} not in memory (evicted) but git branch ${branch} still exists. Use subagent_review to inspect and merge/reject.` }],
            details: { status: "evicted", branch },
          };
        } catch {
          return {
            content: [{ type: "text", text: `Sub-agent ${params.id} not found and its git branch does not exist either. It may have already completed and been cleaned up.` }],
            details: {},
            isError: true,
          };
        }
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
                `Commit error: ${result.error.substring(COMMIT_FAILED_PREFIX.length)}`,
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
        // If JSON.parse fails, only fall back to newline splitting if the input
        // clearly isn't JSON (no leading '[' or contains literal newlines).
        // Malformed JSON like ["a", "b" (missing ']') is surfaced to the caller.
        if (!(e instanceof SyntaxError)) {
          console.error("subagent_parallel: JSON.parse threw non-SyntaxError", e);
          return { content: [{ type: "text", text: `Unexpected parse error: ${e.message}` }], details: {}, isError: true };
        }
        const trimmed = params.tasks.trim();
        if (trimmed.startsWith("[") && !trimmed.includes("\n")) {
          return { content: [{ type: "text", text: `Failed to parse tasks as JSON array: ${e.message}` }], details: {}, isError: true };
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
        // spawnSubAgent promises should always resolve (never reject), but if
        // spawn() throws synchronously inside the Promise executor (e.g., missing
        // pi binary), the promise can reject. Wrap in try/catch to prevent
        // crashing the entire parallel tool on a single spawn failure.
        let batchResults: { task: string; id: string; result: string; status: string; elapsed: number; commitHash?: string }[];
        try {
          batchResults = await Promise.all(batchPromises);
        } catch (e: any) {
          batchResults = batchPromises.map((_, i) => {
            const task = batch[i];
            const id = batchIds[i];
            return { task, id, result: `[Sub-agent spawn error] ${e.message || String(e)}`, status: "error", elapsed: 0 };
          });
        }
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
      const lines = ["Sub-agents:"];
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
      // Wait for process to fully exit before cleaning up worktree to avoid
      // file handle races (e.g., rmSync on locked files after SIGKILL).
      // Attach the close listener BEFORE killing and checking if the pid is
      // alive to avoid a TOCTOU race where the process exits between the
      // check and the listener.
      const { proc } = ag;
      if (proc) {
        const { pid } = proc;
        if (pid !== undefined) {
          const closePromise = new Promise<void>((resolveWait) => {
            const timeout = setTimeout(() => resolveWait(), 3000);
            proc.on("close", () => { clearTimeout(timeout); resolveWait(); });
          });
          try { proc.kill("SIGKILL"); } catch { /* ok */ }
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
        // When resolveGitRoot can't find a parent .git, it returns cwd itself.
        // Detect this by checking for a .git directory in the returned root.
        if (!existsSync(join(root, ".git"))) {
          console.warn(`[subagent] PI_SUBAGENT_ROOT is not set and no git repository found from ${process.cwd()}. Stale sub-agent worktrees cannot be cleaned up. Set PI_SUBAGENT_ROOT or run pi from inside a git repository.`);
          return;
        }
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
          // Read PID + creation timestamp from sentinel to avoid nuking worktrees
          // of a still-running pi session. Format: first line = PID, second line =
          // Date.now() timestamp when the sentinel was created.
          // If the PID is still alive AND belongs to a pi process, skip cleanup.
          // On platforms without /proc, fall back to ps(1) or timestamp-heuristic.
          try {
            const lines = readFileSync(sentinel, "utf-8").trim().split("\n");
            const pid = parseInt(lines[0], 10);
            const creationTime = parseInt(lines[1], 10) || 0;
            if (!isNaN(pid)) {
              try {
                process.kill(pid, 0);
                // PID is alive — verify it's actually a pi agent process, not a
                // recycled PID reused by an unrelated process (PID-reuse TOCTOU).
                let isPiProcess = false;
                let procVerifiable = false;

                // Quick check: if this PID matches our own process, it's definitely a pi session
                if (pid === process.pid) {
                  isPiProcess = true;
                  procVerifiable = true;
                }

                // --- PID-reuse TOCTOU guard: verify process start time against sentinel creation time.
                // If the process started AFTER the sentinel was created, the PID has been recycled
                // by an unrelated process and the original pi agent is dead. This check runs before
                // the cmdline read to definitively detect PID reuse regardless of the new process's name.
                if (!procVerifiable && creationTime > 0) {
                  let processStartTime = 0;
                  // Linux: /proc/<pid>/stat field 22 (1-indexed) = starttime in jiffies since boot
                  try {
                    const statRaw = readFileSync(`/proc/${pid}/stat`, "utf-8");
                    const rparen = statRaw.lastIndexOf(')');
                    if (rparen !== -1) {
                      const fields = statRaw.slice(rparen + 1).trim().split(/\s+/);
                      if (fields.length >= 20) {
                        const starttimeJiffies = parseInt(fields[19], 10);
                        if (!isNaN(starttimeJiffies)) {
                          try {
                            const statFile = readFileSync("/proc/stat", "utf-8");
                            const btimeMatch = statFile.match(/btime\s+(\d+)/);
                            if (btimeMatch) {
                              const CLK_TCK = 100;
                              const bootTimeMs = parseInt(btimeMatch[1], 10) * 1000;
                              processStartTime = bootTimeMs + (starttimeJiffies / CLK_TCK * 1000);
                            }
                          } catch { /* cannot read /proc/stat */ }
                        }
                      }
                    }
                  } catch { /* not Linux or permission denied */ }

                  // macOS / BSD: ps -o lstart= gives absolute start time
                  if (processStartTime === 0) {
                    try {
                      const psOut = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 3000, encoding: "utf-8" });
                      if (psOut.status === 0 && psOut.stdout.trim()) {
                        const parsed = Date.parse(psOut.stdout.trim());
                        if (!isNaN(parsed)) processStartTime = parsed;
                      }
                    } catch { /* ps not available */ }
                  }

                  if (processStartTime > 0 && processStartTime > creationTime + 5000) {
                    // Process started after sentinel creation (5s tolerance for clock skew).
                    // The PID has been recycled by a different process — treat original as dead.
                    isPiProcess = false;
                    procVerifiable = true;
                  }
                }

                // --- Linux: /proc/<pid>/cmdline ---
                if (!procVerifiable) {
                  try {
                    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
                    // Match pi agent process signatures to avoid false positives from
                    // unrelated processes whose names contain "pi" (pipewire, spice-vdagent, etc.).
                    // The pi agent's cmdline always contains either dist/cli.js (entry point)
                    // or path components like /pi/ or pi-agent-core/pi-coding-agent.
                    isPiProcess = /dist\/cli\.js\b/.test(cmdline) || /(?:^|\/)pi(?=[\/\0\s-]|$)/.test(cmdline);
                    procVerifiable = true;
                  } catch {
                    // Not on Linux, or permission denied — try next method
                  }
                }

                // --- macOS / BSD: ps -p <pid> -o command= (full command line) ---
                if (!procVerifiable) {
                  try {
                    const psOut = spawnSync("ps", ["-p", String(pid), "-o", "command="], { timeout: 3000, encoding: "utf-8" });
                    if (psOut.status === 0) {
                      const psCmdline = psOut.stdout.trim();
                      isPiProcess = /dist\/cli\.js\b/.test(psCmdline) || /(?:^|\/)pi(?=[\/\0\s-]|$)/.test(psCmdline);
                      procVerifiable = true;
                    }
                  } catch {
                    // ps not available — fall through
                  }
                }

                if (procVerifiable) {
                  if (isPiProcess) continue;     // verified as a running pi process → skip
                  // verified as NOT pi (recycled PID) → proceed with cleanup
                } else {
                  // No OS-specific verification available (e.g., Windows without WSL).
                  // Conservatively skip cleanup when the PID cannot be verified as pi or non-pi.
                  // Using a timestamp-only heuristic risks nuking worktrees from long-running
                  // pi sessions (>1h) on platforms where /proc and ps are unavailable.
                  console.warn(`[subagent] Cannot verify whether PID ${pid} (sentinel ${sentinel}) is a pi process — skipping cleanup to avoid deleting an active worktree.`);
                  continue;
                }
              } catch { /* dead, proceed with cleanup */ }
            } else {
              // Sentinel file has an unreadable or missing PID (empty file, partial write, corruption).
              // Do NOT treat this as proof of staleness — it means "cannot determine".
              // Skipping cleanup is the safer choice to avoid deleting an active worktree.
              console.warn(`[subagent] Sentinel ${sentinel} has malformed PID (cannot parse): preserving worktree to be safe.`);
              continue;
            }
          } catch {
            // Can't read sentinel at all (permissions, fs error). Treat as indeterminate
            // rather than stale — skip cleanup to be safe.
            console.warn(`[subagent] Cannot read sentinel ${sentinel}: preserving worktree to be safe.`);
            continue;
          }
          const branch = `pi/subagent/${entry}`;
          try {
            git(["worktree", "remove", "--force", wtDir], root);
            // Before deleting the branch, check if it has unmerged commits to prevent data loss.
            // If the sentinel persisted (unlinkSync failed in settle()), a subsequent session_start
            // would delete the branch and destroy committed work. Preserve unmerged commits by
            // moving the branch to the recovered/ namespace.
            // First, check if the branch actually exists before attempting merge-base.
            let branchExists = false;
            try {
              git(["rev-parse", "--verify", branch], root);
              branchExists = true;
            } catch { /* branch already deleted — nothing to preserve */ }
            if (branchExists) {
              try {
                const mergeBase = git(["merge-base", branch, "HEAD"], root).trim();
                const branchTip = git(["rev-parse", branch], root).trim();
                if (mergeBase !== branchTip) {
                  const recoveredBranch = `recovered/subagent/${entry}`;
                  git(["branch", "-m", branch, recoveredBranch], root);
                  console.warn(`[subagent] Stale sentinel for ${entry}: worktree removed; branch renamed to ${recoveredBranch} to preserve unmerged commits.`);
                } else {
                  git(["branch", "-D", branch], root);
                }
              } catch {
                // merge-base or rev-parse failed — rename to recovered/ to preserve
                // unmerged commits rather than force-delete (which could lose data).
                try {
                  const recoveredBranch = `recovered/subagent/${entry}`;
                  git(["branch", "-m", branch, recoveredBranch], root);
                  console.warn(`[subagent] Stale sentinel for ${entry}: merge-base failed; branch preserved as ${recoveredBranch} to avoid data loss.`);
                } catch {
                  git(["branch", "-D", branch], root);
                }
              }
            }
            unlinkSync(sentinel);
          } catch {
            // If the worktree directory no longer exists on disk (successfully removed or
            // manually deleted), remove the sentinel to break the retry cycle even if
            // branch deletion failed. Otherwise the sentinel blocks future session_start
            // cleanup attempts indefinitely.
            if (!existsSync(wtDir)) {
              try { unlinkSync(sentinel); } catch { /* best effort */ }
              try { git(["branch", "-D", branch], root); } catch {
                console.warn(`[subagent] Could not delete stale branch ${branch} after worktree cleanup — manual cleanup may be needed.`);
              }
            }
            // If the worktree directory still exists, leave the sentinel so the next
            // session_start attempt retries the full cleanup.
          }
        }
      } catch { /* ok */ }
    }
  });

  pi.on("session_shutdown", async () => {
    for (const [id, ag] of subAgents) {
      // Only cancel running agents — don't overwrite "done" or other terminal states.
      // Concurrent code reading agent status between the assignment and the clear()
      // below would see misleading state if we unconditionally set "cancelled".
      if (ag.status === "running") {
        ag.status = "cancelled";
        try { ag.proc?.kill("SIGKILL"); } catch { /* process may have already exited */ }
      }
    }
    // Yield to event loop so close handlers of killed processes can fire and settle
    // before we clear the map. Without this, a closeHandler's resolve() call could
    // race with subAgents.clear(), potentially leaving stale agent references in
    // running promise chains.
    await new Promise(r => setTimeout(r, 200));
    // Don't auto-cleanup worktrees — they contain committed work that may be valuable
    subAgents.clear();
  });
}
