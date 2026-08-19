/**
 * Git worktree lifecycle for sub-agents (ported from the subagent extension).
 *
 * Every sub-agent gets its own worktree + branch under .pi/subagent/.
 * Non-git projects are auto-initialized. Commit/review/merge/reject map to
 * plain git operations.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const msg = result.signal
			? `git ${args[0]} killed by ${result.signal}`
			: result.stderr?.trim() || `git ${args[0]} exited with code ${result.status}`;
		const err: any = new Error(msg);
		err.stderr = result.stderr || "";
		err.stdout = result.stdout || "";
		err.status = result.status;
		err.signal = result.signal;
		throw err;
	}
	return result.stdout || "";
}

export function gitQuiet(args: string[], cwd: string): string {
	try {
		return git(args, cwd);
	} catch (e: any) {
		return e.stderr || e.message || "";
	}
}

export function safeId(raw: string): string | null {
	const cleaned = raw
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	if (cleaned.length === 0 || cleaned.length > 71) return null;
	if (cleaned === raw) return cleaned;
	const hash = createHash("sha256").update(raw).digest("hex").substring(0, 8);
	return `${cleaned}-${hash}`;
}

export function branchName(id: string, safe?: string | null): string {
	const s = safe ?? safeId(id);
	if (!s) {
		const hash = createHash("sha256").update(id).digest("hex").substring(0, 12);
		return `pi/subagent/fallback-${hash}`;
	}
	return `pi/subagent/${s}`;
}

function safeStashPop(ctxCwd: string, execId: string, context: string): boolean {
	try {
		git(["stash", "pop"], ctxCwd);
		return true;
	} catch {
		console.warn(
			`  !!! git stash pop failed ${context} for ${execId}. ` +
				"The stash entry has been LEFT IN PLACE to avoid data loss. " +
				"You can recover it manually: git stash list",
		);
		return false;
	}
}

export function ensureGitRepo(projectRoot: string): string {
	const gitDir = join(projectRoot, ".git");
	if (existsSync(gitDir)) {
		try {
			git(["rev-parse", "--git-dir"], projectRoot);
			return projectRoot;
		} catch {
			if (!existsSync(join(gitDir, "HEAD"))) {
				try {
					rmSync(gitDir, { recursive: true, force: true });
				} catch {
					/* can't remove, will fail below */
				}
			}
			if (existsSync(gitDir)) {
				try {
					git(["status", "--porcelain"], projectRoot);
					return projectRoot;
				} catch {
					try {
						rmSync(gitDir, { recursive: true, force: true });
					} catch {
						throw new Error(
							`Cannot initialize git repo at ${projectRoot}: .git is corrupted and cannot be removed.`,
						);
					}
				}
			}
		}
	}

	if (existsSync(gitDir)) {
		throw new Error(`Cannot initialize git repo at ${projectRoot}: .git still exists after repair attempt.`);
	}

	try {
		git(["init"], projectRoot);
	} catch (e: any) {
		throw new Error(`git init failed: ${e.stderr || e.message}`);
	}
	const gitignorePath = join(projectRoot, ".gitignore");
	if (!existsSync(gitignorePath)) {
		try {
			writeFileSync(
				gitignorePath,
				`${[
					"# Auto-generated for sub-agent tracking",
					"node_modules/",
					".env",
					".env.*",
					"*.log",
					"dist/",
					"build/",
					".DS_Store",
					"*.swp",
					"*.swo",
					".pi/subagent/",
				].join("\n")}\n`,
			);
		} catch {
			/* best effort */
		}
	} else {
		try {
			const content = readFileSync(gitignorePath, "utf-8");
			if (!content.includes(".pi/subagent/")) {
				console.warn(
					`! ${gitignorePath} exists but does not exclude .pi/subagent/. Sub-agent worktree contents could be staged by git add -A. Consider adding ".pi/subagent/" to your .gitignore.`,
				);
			}
		} catch {
			/* best effort */
		}
	}
	try {
		git(["add", "-A", "--ignore-errors"], projectRoot);
		git(["commit", "-m", "pi: initial snapshot (auto-created for sub-agent tracking)", "--allow-empty"], projectRoot);
	} catch {
		git(["commit", "-m", "pi: initial snapshot", "--allow-empty"], projectRoot);
	}

	return projectRoot;
}

/** Create a worktree + branch for a sub-agent. Returns the worktree path. */
/** Deterministic worktree path for a sub-agent id (the layout `createWorktree` uses). */
export function subagentWorktreePath(projectRoot: string, id: string): string {
	const safe = safeId(id);
	if (!safe) throw new Error(`Invalid sub-agent id for worktree: "${id.substring(0, 40)}"`);
	return join(projectRoot, ".pi", "subagent", safe);
}

export function createWorktree(projectRoot: string, id: string): string {
	const safe = safeId(id);
	if (!safe) throw new Error(`Invalid sub-agent id for worktree: "${id.substring(0, 40)}"`);
	const branch = branchName(id, safe);
	const wtDir = subagentWorktreePath(projectRoot, id);

	mkdirSync(join(projectRoot, ".pi", "subagent"), { recursive: true });

	gitQuiet(["worktree", "remove", "--force", wtDir], projectRoot);
	gitQuiet(["branch", "-D", branch], projectRoot);

	let headRef: string;
	try {
		headRef = git(["rev-parse", "--verify", "HEAD"], projectRoot).trim();
	} catch {
		git(["commit", "-m", "pi: placeholder", "--allow-empty"], projectRoot);
		try {
			headRef = git(["rev-parse", "--verify", "HEAD"], projectRoot).trim();
		} catch (e: any) {
			throw new Error(`Failed to resolve HEAD after placeholder commit: ${e.stderr || e.message}`);
		}
	}

	git(["branch", branch, headRef], projectRoot);

	try {
		git(["rev-parse", "--verify", branch], projectRoot);
	} catch (e: any) {
		throw new Error(`Failed to create branch ${branch}: ${e.message || e}`);
	}

	try {
		git(["worktree", "add", wtDir, branch], projectRoot);
	} catch (e: any) {
		gitQuiet(["branch", "-d", branch], projectRoot);
		throw new Error(`Worktree add failed: ${e.stderr || e.message}`);
	}

	return wtDir;
}

/** Diff between a sub-agent branch and the branch it was forked from. */
export function getDiff(projectRoot: string, id: string): string {
	const branch = branchName(id);
	try {
		const mergeBase = git(["merge-base", "HEAD", branch], projectRoot).trim();
		const diff = git(["diff", mergeBase, branch], projectRoot);
		const log = git(["log", "--oneline", `${mergeBase}..${branch}`], projectRoot);
		return `--- Commits ---\n${log}\n\n--- Diff ---\n${diff}`;
	} catch (e: any) {
		return `Unable to get diff: ${e.stderr || e.message}`;
	}
}

export interface CommitResult {
	ok: boolean;
	/** Commit hash. Empty when there were no changes; "committed-no-hash" when hash retrieval failed. */
	hash: string;
	reason?: string;
}

/** Commit changes inside the worktree (git runs with the worktree as cwd). */
export function commitWorktree(
	worktreePath: string,
	id: string,
	task: string,
	gitName = "pi-subagent",
	gitEmail = "pi-subagent@localhost",
): CommitResult {
	let truncated: string;
	try {
		const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
		const segments = [...segmenter.segment(task)].slice(0, 80);
		truncated = segments.map((s) => s.segment).join("");
	} catch {
		truncated = Array.from(task).slice(0, 80).join("");
	}
	if (!truncated || !truncated.trim()) truncated = "(empty task)";
	const msg = id ? `pi: ${id} — ${truncated}` : `pi: ${truncated}`;

	if (!worktreePath) return { ok: false, hash: "", reason: "worktree path is empty" };
	const dotGit = join(worktreePath, ".git");
	if (!existsSync(dotGit)) return { ok: false, hash: "", reason: ".git file missing" };
	try {
		const st = lstatSync(dotGit);
		if (!st.isFile()) {
			console.warn(
				`commitWorktree: refusing to commit in ${worktreePath} — .git is a directory, not a worktree marker file`,
			);
			return { ok: false, hash: "", reason: ".git is a directory, not a worktree marker file" };
		}
	} catch {
		return { ok: false, hash: "", reason: "cannot stat .git file" };
	}

	try {
		if (!git(["status", "--porcelain"], worktreePath).trim()) return { ok: true, hash: "" };
	} catch (e: any) {
		console.error(
			`commitWorktree: git status --porcelain failed in ${worktreePath}: ${(e.message || e).substring(0, 200)}`,
		);
		return { ok: false, hash: "", reason: `git status failed: ${(e.message || e).substring(0, 100)}` };
	}

	try {
		git(["add", "-A"], worktreePath);
		try {
			git(["commit", "-m", msg], worktreePath);
		} catch {
			// A missing git identity (user.name/user.email) must not discard
			// sub-agent work — retry once with the configured identity for this
			// commit only. Any other failure simply fails again below.
			git(["-c", `user.name=${gitName}`, "-c", `user.email=${gitEmail}`, "commit", "-m", msg], worktreePath);
		}
		try {
			return { ok: true, hash: git(["rev-parse", "--short", "HEAD"], worktreePath).trim() };
		} catch {
			const fullHash = gitQuiet(["rev-parse", "HEAD"], worktreePath).trim();
			if (/^[a-f0-9]{40}$/.test(fullHash)) return { ok: true, hash: fullHash.substring(0, 7) };
			const logHash = gitQuiet(["log", "--format=%h", "-n", "1"], worktreePath).trim();
			if (/^[a-f0-9]{7,40}$/.test(logHash)) return { ok: true, hash: logHash.substring(0, 7) };
			console.warn(`commitWorktree: commit succeeded but all hash retrieval methods failed in ${worktreePath}`);
			return { ok: true, hash: "committed-no-hash" };
		}
	} catch (e: any) {
		try {
			git(["reset", "HEAD"], worktreePath);
		} catch (resetErr: any) {
			console.error(
				`commitWorktree: git reset HEAD also failed in ${worktreePath}: ${(resetErr.message || resetErr).substring(0, 200)}`,
			);
		}
		console.error(`commitWorktree failed in ${worktreePath}: ${(e.message || e).substring(0, 200)}`);
		return { ok: false, hash: "", reason: `git add/commit failed: ${(e.message || e).substring(0, 100)}` };
	}
}

/**
 * True when the sub-agent branch has commits not reachable from the project
 * HEAD (i.e. work worth reviewing). False when the branch is missing or
 * points at the fork point.
 */
export function hasBranchCommits(projectRoot: string, id: string): boolean {
	try {
		const count = git(["rev-list", "--count", branchName(id), "--not", "HEAD"], projectRoot).trim();
		return Number.parseInt(count, 10) > 0;
	} catch {
		return false;
	}
}

export interface CleanupResult {
	branchDeleted: boolean;
	worktreeRemoved: boolean;
	worktreeGitRemoved: boolean;
	worktreeDirRemoved: boolean;
}

/** Clean up worktree and optionally the branch. */
export function cleanupWorktree(projectRoot: string, id: string, deleteBranch: boolean): CleanupResult {
	const safe = safeId(id);
	if (!safe)
		return { branchDeleted: false, worktreeRemoved: false, worktreeGitRemoved: false, worktreeDirRemoved: false };
	const wtDir = join(projectRoot, ".pi", "subagent", safe);
	const branch = branchName(id);
	let worktreeGitRemoved = false;
	let worktreeDirRemoved = false;
	let branchDeleted = false;
	try {
		git(["worktree", "remove", "--force", wtDir], projectRoot);
		worktreeGitRemoved = true;
	} catch {
		/* ok */
	}
	try {
		rmSync(wtDir, { recursive: true, force: true });
		worktreeDirRemoved = true;
	} catch {
		/* ok */
	}
	if (deleteBranch) {
		try {
			git(["branch", "-D", branch], projectRoot);
			branchDeleted = true;
		} catch {
			/* ok */
		}
	}
	return {
		branchDeleted,
		worktreeRemoved: worktreeGitRemoved && worktreeDirRemoved,
		worktreeGitRemoved,
		worktreeDirRemoved,
	};
}

export interface MergeBranchOptions {
	stashPolicy: "reject" | "auto";
	onCommitFailure: "abort-merge" | "keep-merge";
	description: string;
}

export interface MergeBranchResult {
	success: boolean;
	retainForManualReview: boolean;
	hasConflicts: boolean;
	conflictFiles: string;
	error?: string;
	stashWarning?: string;
}

const COMMIT_FAILED_PREFIX = "COMMIT FAILED: ";

export function mergeBranch(ctxCwd: string, execId: string, options: MergeBranchOptions): MergeBranchResult {
	const branch = branchName(execId);

	try {
		git(["rev-parse", "--verify", branch], ctxCwd);
	} catch {
		return {
			success: false,
			retainForManualReview: false,
			hasConflicts: false,
			conflictFiles: "",
			error: "Branch not found",
		};
	}

	let stashed = false;
	const dirty = gitQuiet(["status", "--porcelain"], ctxCwd).trim();
	if (dirty) {
		if (options.stashPolicy === "reject") {
			return {
				success: false,
				retainForManualReview: false,
				hasConflicts: false,
				conflictFiles: "",
				error: "Dirty working tree",
			};
		}
		if (options.stashPolicy === "auto") {
			try {
				git(["stash", "push", "--include-untracked", "-m", `pi: auto-stash before merge ${execId}`], ctxCwd);
				stashed = true;
			} catch (e: any) {
				console.warn(`  ! git stash push failed before merge ${execId}: ${(e.message || "").substring(0, 80)}`);
				return {
					success: false,
					retainForManualReview: true,
					hasConflicts: false,
					conflictFiles: "",
					error: `git stash push failed: ${(e.message || "").substring(0, 80)}`,
				};
			}
		}
	}

	try {
		git(["merge-base", "--is-ancestor", branch, "HEAD"], ctxCwd);
		if (stashed) safeStashPop(ctxCwd, execId, "after up-to-date merge");
		return { success: true, retainForManualReview: false, hasConflicts: false, conflictFiles: "" };
	} catch (e: any) {
		if (e.status !== 1) {
			if (stashed) safeStashPop(ctxCwd, execId, "after merge-base failure");
			return {
				success: false,
				retainForManualReview: true,
				hasConflicts: false,
				conflictFiles: "",
				error: `git merge-base failed: ${(e.message || "").substring(0, 80)}`,
			};
		}
		/* not up to date — proceed with merge */
	}

	try {
		git(["merge", "--no-commit", "--no-ff", branch], ctxCwd);
	} catch (mergeErr: any) {
		let unmerged = "";
		try {
			unmerged = git(["ls-files", "-u"], ctxCwd).trim();
		} catch {
			/* cannot determine conflicts */
		}
		const isConflict = unmerged.length > 0;
		let conflictFiles = "";
		if (isConflict) {
			const seen = new Set<string>();
			for (const line of unmerged.split("\n")) {
				const tabIdx = line.indexOf("\t");
				if (tabIdx >= 0) {
					const path = line.substring(tabIdx + 1);
					if (path) seen.add(path);
				}
			}
			conflictFiles = [...seen].join("\n");
		}
		gitQuiet(["merge", "--abort"], ctxCwd);
		if (stashed) safeStashPop(ctxCwd, execId, "after merge conflict");
		if (isConflict) {
			return {
				success: false,
				retainForManualReview: true,
				hasConflicts: true,
				conflictFiles,
				error: "Merge conflicts",
			};
		}
		return {
			success: false,
			retainForManualReview: false,
			hasConflicts: false,
			conflictFiles: "",
			error: mergeErr.stderr || mergeErr.message || "Unknown merge error",
		};
	}

	try {
		git(
			["commit", "-m", `pi: merge ${execId}: ${options.description.substring(0, 60)}`, "--no-edit", "--allow-empty"],
			ctxCwd,
		);
	} catch (commitErr: any) {
		if (options.onCommitFailure === "abort-merge") {
			gitQuiet(["merge", "--abort"], ctxCwd);
			if (stashed) safeStashPop(ctxCwd, execId, "after abort-merge");
			return {
				success: false,
				retainForManualReview: false,
				hasConflicts: false,
				conflictFiles: "",
				error: `${COMMIT_FAILED_PREFIX}${(commitErr.message || "").substring(0, 200)}`,
			};
		}
		console.error(
			`  ! Merge of ${execId} applied but commit failed (${(commitErr.message || "").substring(0, 80)}). Branch retained for manual review.`,
		);
		if (stashed) safeStashPop(ctxCwd, execId, "after keep-merge");
		return {
			success: false,
			retainForManualReview: true,
			hasConflicts: false,
			conflictFiles: "",
			error: `${COMMIT_FAILED_PREFIX}${(commitErr.message || "").substring(0, 200)}`,
		};
	}

	if (stashed && !safeStashPop(ctxCwd, execId, "after successful merge")) {
		return {
			success: true,
			retainForManualReview: false,
			hasConflicts: false,
			conflictFiles: "",
			stashWarning: `git stash pop failed after successful merge of ${execId}. Uncommitted changes are in the stash — recover with: git stash list && git stash pop`,
		};
	}
	return { success: true, retainForManualReview: false, hasConflicts: false, conflictFiles: "" };
}
