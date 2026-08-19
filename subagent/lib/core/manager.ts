/**
 * SubagentManager — the runtime-agnostic sub-agent core: git worktree
 * isolation, lifecycle state machine, crash-resume metadata, followup
 * re-tasking, spawn-tree tracking.
 *
 * The host (pi coding-agent standalone, or the DeepSeek Harness worktree
 * provider plugin) supplies the model loop through the protected template
 * methods: `resolveModel`, `runSubagent`, `buildChildToolset`, and the
 * todo/notification hooks. Everything else — id allocation, worktree
 * creation, meta persistence, cancel/timeout races, auto-commit, failure
 * salvage, review/merge/reject — lives here and is host-independent.
 *
 * spawn → worktree + host run → auto-commit → report.
 * review/merge/reject operate on the sub-agent's branch.
 * Recursive delegation: children spawn through the same manager with depth+1.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedModel, SpawnSubagentOptions, SubAgent, SubagentRunRequest, SubagentRunResult } from "./types.ts";
import {
	branchName,
	cleanupWorktree,
	commitWorktree,
	createWorktree,
	ensureGitRepo,
	getDiff,
	git,
	hasBranchCommits,
	mergeBranch,
} from "./worktree.ts";

export interface SubagentManagerOptions {
	/** The git repository root all worktrees fork from. */
	projectRoot: string;
	maxDepth: number;
	maxConcurrent: number;
	defaultTimeoutMs: number;
	gitName?: string;
	gitEmail?: string;
	/**
	 * Additional developer instructions appended to every sub-agent system
	 * prompt (codex multi-agent v2: `subagent_developer_instructions`).
	 */
	subagentInstructions?: string;
}

let spawnCounter = 0;

/**
 * Crash-resume metadata, written per sub-agent under
 * <projectRoot>/.pi/subagent/meta/<id>.json (outside the worktree, so it
 * never lands in the sub-agent's branch). On manager construction the file
 * is read back and the sub-agent re-registered as "interrupted" — the
 * worktree and branch survive a host crash and can be reviewed, merged,
 * rejected, or continued.
 */
interface SubAgentMeta {
	id: string;
	task: string;
	readOnly?: boolean;
	depth: number;
	parentId?: string;
	branch: string;
	worktreePath: string;
	projectRoot: string;
	model: string;
	startTime: number;
	todoId?: string | null;
	/** Terminal status when the run settled before the host stopped. Absent = crashed mid-run. */
	status?: SubAgent["status"];
	commitHash?: string;
}

function metaDir(projectRoot: string): string {
	return join(projectRoot, ".pi", "subagent", "meta");
}

function metaPath(projectRoot: string, id: string): string {
	return join(metaDir(projectRoot), `${id}.json`);
}

export class SubagentManager {
	private readonly agents = new Map<string, SubAgent>();

	private readonly options: SubagentManagerOptions;

	constructor(options: SubagentManagerOptions) {
		this.options = options;
		// Re-register sub-agents whose meta.json survived a crash/shutdown, so
		// their worktree + branch can be reviewed, merged, rejected, or
		// continued in this session.
		try {
			this.restoreInterrupted();
		} catch {
			/* restore is best-effort */
		}
		// Best-effort: drop on-disk leftovers of agents in a terminal state.
		// Must run AFTER restoreInterrupted — before it, the agents map is
		// empty and sweep is a no-op.
		try {
			this.sweep();
		} catch {
			/* sweep is best-effort */
		}
	}

	// ========================================================================
	// Host seams (template methods — the subclass supplies the runtime)
	// ========================================================================

	/**
	 * Resolve a model ref (`provider/id`, or a bare id) to a concrete model.
	 * Return undefined when unresolvable — spawn/launch error out cleanly.
	 */
	protected resolveModel(_modelRef?: string): ResolvedModel | undefined {
		return undefined;
	}

	/** Run one model loop inside the agent's worktree. */
	protected async runSubagent(_request: SubagentRunRequest): Promise<SubagentRunResult> {
		throw new Error("SubagentManager.runSubagent is not implemented — the host must override it.");
	}

	/**
	 * Build the recursive child toolset exposed to the running agent. The host
	 * casts the returned array to its own tool type.
	 */
	protected buildChildToolset(_depth: number, _spawnerId: string): unknown[] {
		return [];
	}

	/** Called when a run starts (host: create a todo entry). Returns an opaque handle. */
	protected onRunStarted(_agent: SubAgent): unknown {
		return null;
	}

	/** Called from the run's `finally` (host: settle the todo entry). */
	protected onRunSettled(_agent: SubAgent, _runHandle: unknown): void {}

	/** Called when the run reaches a terminal state (host: UI toast). */
	protected notifyCompletion(_agent: SubAgent): void {}

	/**
	 * Fired once when a settle leaves no running/pending agents behind —
	 * the workflow-level wake ("everything finished, come collect"). Only
	 * fires when at least one non-silent agent exists. Default: no-op.
	 */
	protected onAllSettled(_agents: SubAgent[]): void {}

	/**
	 * Deliver a steering message to a RUNNING agent's in-process loop.
	 * Default: throws (host without steering support).
	 */
	protected deliverSteering(_agent: SubAgent, _text: string): void {
		throw new Error("steering not supported by this host");
	}

	/** Called when a run cannot start (model missing) — before any promise exists. */
	protected notifyStartFailure(_agent: SubAgent): void {}

	// ========================================================================
	// Metadata
	// ========================================================================

	/** Write the crash-resume metadata file for a sub-agent. */
	private writeMeta(agent: SubAgent): void {
		if (!agent.branch) return; // read-only agents have no work to salvage
		try {
			mkdirSync(metaDir(agent.projectRoot), { recursive: true });
			const runHandle = (agent as SubAgent & { runHandle?: unknown }).runHandle as string | null | undefined;
			const meta: SubAgentMeta = {
				id: agent.id,
				task: agent.task,
				...(agent.readOnly === undefined ? {} : { readOnly: agent.readOnly }),
				depth: agent.depth,
				...(agent.parentId === undefined ? {} : { parentId: agent.parentId }),
				branch: agent.branch,
				worktreePath: agent.worktreePath,
				projectRoot: agent.projectRoot,
				model: agent.model ?? "",
				startTime: agent.startTime,
				...(agent.status === undefined || agent.status === "running" ? {} : { status: agent.status }),
				...(agent.commitHash === undefined ? {} : { commitHash: agent.commitHash }),
				...(runHandle === undefined || runHandle === null ? {} : { todoId: runHandle }),
			};
			writeFileSync(metaPath(agent.projectRoot, agent.id), JSON.stringify(meta, null, 2), { mode: 0o600 });
		} catch {
			/* metadata is best-effort — a failed write must not break spawn */
		}
	}

	private deleteMeta(agent: SubAgent): void {
		try {
			rmSync(metaPath(agent.projectRoot, agent.id), { force: true });
		} catch {
			/* best-effort */
		}
	}

	/** Re-register sub-agents found in the meta directory (crash survivors). */
	private restoreInterrupted(): void {
		const dir = metaDir(this.options.projectRoot);
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			return; // no meta dir yet
		}
		for (const file of files) {
			try {
				const meta = JSON.parse(readFileSync(join(dir, file), "utf-8")) as SubAgentMeta;
				if (!meta?.id || this.agents.has(meta.id)) continue;
				if (!existsSync(meta.worktreePath)) {
					// Worktree gone — nothing to salvage; drop the stale meta.
					rmSync(metaPath(meta.projectRoot, meta.id), { force: true });
					continue;
				}
				const settledStatus = meta.status;
				const agent: SubAgent = {
					id: meta.id,
					task: meta.task,
					// A meta written before the settle path ran means the process died
					// mid-run → interrupted. A terminal status means the run finished
					// and the meta was kept for review — restore it faithfully.
					status: settledStatus ?? "interrupted",
					depth: meta.depth,
					...(meta.parentId === undefined ? {} : { parentId: meta.parentId }),
					// Restore readOnly too: without it, subagent_continue would run a
					// read-only agent with full tools (privilege escalation).
					...(meta.readOnly === undefined ? {} : { readOnly: meta.readOnly }),
					...(meta.commitHash === undefined ? {} : { commitHash: meta.commitHash }),
					branch: meta.branch,
					worktreePath: meta.worktreePath,
					projectRoot: meta.projectRoot,
					startTime: meta.startTime,
					endTime: Date.now(),
					model: meta.model,
					...(settledStatus === undefined
						? {
								error:
									"Interrupted by an external shutdown — the process ended before this sub-agent finished. " +
									"Review the worktree, merge/reject it, or continue it.",
							}
						: {}),
				};
				this.agents.set(meta.id, agent);
			} catch {
				/* corrupt meta — ignore */
			}
		}
	}

	list(): SubAgent[] {
		return [...this.agents.values()];
	}

	get(id: string): SubAgent | undefined {
		return this.agents.get(id);
	}

	private runningCount(): number {
		let n = 0;
		for (const a of this.agents.values()) if (a.status === "running") n++;
		return n;
	}

	private resolveModelOrThrow(modelRef?: string): ResolvedModel {
		const model = this.resolveModel(modelRef);
		if (!model) {
			throw new Error(modelRef ? `Model not found: ${modelRef}` : "No model selected in the parent session.");
		}
		return model;
	}

	async spawn(options: SpawnSubagentOptions): Promise<SubAgent> {
		const depth = options.depth ?? 0;
		if (depth >= this.options.maxDepth) {
			throw new Error(`Sub-agent depth limit reached (${this.options.maxDepth}). Solve the task yourself.`);
		}

		// DAG validation — deps must exist (an agent cannot depend on its spawner).
		const dependsOn = options.dependsOn ?? [];
		for (const depId of dependsOn) {
			if (!this.agents.get(depId)) throw new Error(`dependsOn: unknown agent ${depId}`);
			if (depId === options.parentId) throw new Error(`dependsOn: an agent cannot depend on its own spawner`);
		}
		const queued = dependsOn.length > 0;

		if (!queued && this.runningCount() >= this.options.maxConcurrent) {
			throw new Error(
				`Concurrency limit reached (${this.options.maxConcurrent} running sub-agents). Wait for one to finish, cancel one, or queue with dependsOn.`,
			);
		}
		const model = this.resolveModelOrThrow(options.model);
		const readOnly = options.readOnly ?? false;
		if (!readOnly) ensureGitRepo(this.options.projectRoot);

		// Timestamp + counter + random suffix: even agents created in the same
		// millisecond (parallel fan-out, or a process restart that does not
		// reset the counter) can never collide.
		const id = `sa-${Date.now().toString(36)}-${String(spawnCounter++).padStart(3, "0")}-${randomBytes(2).toString("hex")}`;

		// Immediate write-path spawn: create the worktree eagerly so setup
		// failures surface as spawn errors (queued agents defer to launch).
		let worktreePath = this.options.projectRoot;
		let branch = "";
		if (!readOnly && !queued) {
			worktreePath = createWorktree(this.options.projectRoot, id);
			branch = branchName(id);
		}

		const agent: SubAgent = {
			id,
			task: options.task,
			status: queued ? "pending" : "running",
			depth,
			...(options.parentId === undefined ? {} : { parentId: options.parentId }),
			branch,
			worktreePath,
			projectRoot: this.options.projectRoot,
			startTime: Date.now(),
			readOnly,
			dependsOn: queued ? dependsOn : undefined,
			silent: options.silent,
			model: `${model.provider}/${model.id}`,
		};
		if (queued) {
			agent.promise = new Promise<void>((resolve) => this.pendingResolvers.set(id, resolve));
		}
		this.agents.set(id, agent);
		if (queued) {
			// Deps may already be settled (spawned after the fact).
			this.schedulePending();
		} else {
			this.launch(agent, {
				taskText: options.task,
				timeoutMs: options.timeoutMs,
			});
		}
		return agent;
	}

	/** Resolvers for `agent.promise` of queued agents (resolved on any terminal transition). */
	private readonly pendingResolvers = new Map<string, () => void>();

	private resolvePending(id: string): void {
		this.pendingResolvers.get(id)?.();
		this.pendingResolvers.delete(id);
	}

	/**
	 * Send a message into a queued (prompt addendum) or running (steering)
	 * agent. Terminal agents cannot be messaged — use followup.
	 */
	message(id: string, text: string): SubAgent {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Unknown sub-agent: ${id}`);
		if (agent.status === "pending") {
			agent.task += `\n\n${text}`;
			return agent;
		}
		if (agent.status === "running") {
			this.deliverSteering(agent, text);
			return agent;
		}
		throw new Error(`Sub-agent ${id} is ${agent.status} — use followup to re-task a finished agent`);
	}

	/** Terminal statuses that let dependents proceed (success). */
	private static readonly DEPS_OK = new Set(["done", "merged"]);
	/** Terminal statuses that cascade-cancel dependents. */
	private static readonly DEPS_FAILED = new Set(["error", "cancelled", "timeout", "rejected"]);

	/**
	 * One scheduling pass over queued agents. Idempotent; called after every
	 * settle (and right after a queued spawn, since deps may already be
	 * done). Map insertion order keeps cascades inside a pass: a dependent
	 * is always spawned after its deps. `interrupted` deps keep dependents
	 * waiting — a crash resume may still complete them.
	 */
	private schedulePending(): void {
		for (const agent of this.agents.values()) {
			if (agent.status !== "pending") continue;
			const deps = (agent.dependsOn ?? [])
				.map((depId) => this.agents.get(depId))
				.filter((d): d is SubAgent => d !== undefined);
			const failed = deps.find((d) => SubagentManager.DEPS_FAILED.has(d.status));
			if (failed) {
				agent.status = "cancelled";
				agent.error = `dependency ${failed.id} ended ${failed.status}`;
				agent.endTime = Date.now();
				this.resolvePending(agent.id);
				this.notifyCompletion(agent);
				continue;
			}
			if (deps.length > 0 && deps.every((d) => SubagentManager.DEPS_OK.has(d.status))) {
				if (this.runningCount() >= this.options.maxConcurrent) continue; // stay queued
				try {
					// Pre-validate the pinned model before committing a launch slot.
					this.resolveModelOrThrow(agent.model);
				} catch (e) {
					agent.status = "error";
					agent.error = e instanceof Error ? e.message : String(e);
					agent.endTime = Date.now();
					this.resolvePending(agent.id);
					this.notifyCompletion(agent);
					continue;
				}
				// Write path: create the deferred worktree now (queued agents stay cheap).
				if (!agent.readOnly && !agent.branch) {
					try {
						agent.worktreePath = createWorktree(this.options.projectRoot, agent.id);
						agent.branch = branchName(agent.id);
					} catch (e) {
						agent.status = "error";
						agent.error = `worktree creation failed: ${e instanceof Error ? e.message : String(e)}`;
						agent.endTime = Date.now();
						this.resolvePending(agent.id);
						this.notifyCompletion(agent);
						continue;
					}
				}
				agent.status = "running";
				const taskText = this.withUpstreamReports(agent, deps);
				agent.dependsOn = undefined;
				this.launch(agent, { taskText, timeoutMs: undefined });
			}
		}
	}

	/** Cap for one upstream report injected into a dependent's prompt. */
	private static readonly MAX_REPORT_PER_DEP = 2000;
	/** Cap for the whole injected upstream block. */
	private static readonly MAX_UPSTREAM_BLOCK = 6000;

	/** Prefix the dependent's task with the (capped) reports of its deps. */
	private withUpstreamReports(agent: SubAgent, deps: SubAgent[]): string {
		const blocks: string[] = [];
		let total = 0;
		for (const dep of deps) {
			const report = (dep.result ?? "(no report)").trim();
			const clipped =
				report.length > SubagentManager.MAX_REPORT_PER_DEP
					? `${report.slice(0, SubagentManager.MAX_REPORT_PER_DEP)}\n… (truncated)`
					: report;
			blocks.push(`[upstream ${dep.id} — ${dep.task.slice(0, 80)}]\n${clipped}`);
			total += clipped.length;
			if (total >= SubagentManager.MAX_UPSTREAM_BLOCK) break;
		}
		return `Upstream agent results (from your dependencies — build on these):\n\n${blocks.join("\n\n")}\n\n---\n\nYour task: ${agent.task}`;
	}

	/** Post-settle bookkeeping: schedule dependents, then maybe fire the aggregate wake. */
	private afterSettle(): void {
		this.schedulePending();
		const busy = [...this.agents.values()].some((a) => a.status === "running" || a.status === "pending");
		if (!busy && [...this.agents.values()].some((a) => !a.silent)) {
			this.onAllSettled(this.list());
		}
	}

	/**
	 * Re-task a terminal sub-agent in its existing worktree and branch
	 * (codex multi-agent v2: `followup_task`). The new task runs with a fresh
	 * model context, but every commit and uncommitted change from the
	 * previous run is still on the branch — the follow-up prompt tells the
	 * agent to inspect `git log`/`git status` before acting.
	 *
	 * Eligible statuses: done, error, timeout, interrupted (use
	 * continueAgent for interrupted runs whose ORIGINAL task is unfinished).
	 * merged/rejected/cancelled agents had their worktrees cleaned up.
	 */
	async followup(id: string, task: string, options: { model?: string; timeoutMs?: number } = {}): Promise<SubAgent> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "running" || agent.status === "pending") {
			throw new Error(`Sub-agent ${id} is still ${agent.status} — use subagent_message instead.`);
		}
		if (agent.status === "merged" || agent.status === "rejected" || agent.status === "cancelled") {
			throw new Error(
				`Sub-agent ${id} is ${agent.status} — its worktree was cleaned up. Spawn a new agent instead.`,
			);
		}
		if (this.runningCount() >= this.options.maxConcurrent) {
			throw new Error(
				`Concurrency limit reached (${this.options.maxConcurrent} running sub-agents). Wait for one to finish or cancel one.`,
			);
		}
		// Read-only agents share the project directory — nothing to verify.
		if (agent.branch) {
			if (!existsSync(agent.worktreePath)) {
				agent.status = "error";
				agent.error = "Worktree missing — nothing to follow up on.";
				this.deleteMeta(agent);
				throw new Error(`Worktree for ${id} is gone.`);
			}
			if (!existsSync(join(agent.worktreePath, ".git"))) {
				agent.status = "error";
				agent.error = "Worktree is not a git checkout — nothing to follow up on.";
				this.deleteMeta(agent);
				throw new Error(`Worktree for ${id} is not a git checkout.`);
			}
			let branchOk = true;
			try {
				git(["rev-parse", "--verify", agent.branch], agent.worktreePath);
			} catch {
				branchOk = false;
			}
			if (!branchOk) {
				agent.status = "error";
				agent.error = `Branch ${agent.branch} removed — nothing to follow up on.`;
				this.deleteMeta(agent);
				throw new Error(`Branch ${agent.branch} for ${id} is gone.`);
			}
		}
		// A model override re-resolves cheap leaf models for the follow-up
		// (codex multi-agent v2: leaf-model support); the resolved ref is
		// pinned on the agent so launch() can restore it.
		if (options.model !== undefined) {
			const model = this.resolveModelOrThrow(options.model);
			agent.model = `${model.provider}/${model.id}`;
		}
		const previousTask = agent.branch
			? `Previous task on this branch (${agent.branch}): ${agent.task}`
			: `Previous read-only task: ${agent.task}`;
		agent.task = task;
		agent.status = "running";
		delete agent.error;
		delete agent.endTime;
		agent.startTime = Date.now();
		delete agent.result;
		delete agent.commitHash;
		const taskText = agent.branch
			? [
					"[FOLLOW-UP TASK] This worktree and branch already contain work from an earlier task.",
					"Before acting, inspect the current state: git log --oneline, git status, and the files involved.",
					"Build on the existing work; do not reset the branch or discard prior commits unless the task requires it.",
					"",
					previousTask,
					"",
					"New task:",
					"",
					task,
				].join("\n")
			: [
					"[FOLLOW-UP TASK] You previously completed a read-only research task in this project.",
					"",
					previousTask,
					"",
					"New task:",
					"",
					task,
				].join("\n");
		this.launch(agent, {
			taskText,
			timeoutMs: options.timeoutMs,
		});
		return agent;
	}

	/**
	 * Resume an interrupted sub-agent (crash survivor) in its existing
	 * worktree and branch. The original task is re-issued with a note to
	 * inspect the partial work first; the model context starts fresh, but
	 * every file change from the previous attempt is still on disk.
	 */
	async continueAgent(id: string): Promise<SubAgent> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "running") throw new Error(`Sub-agent ${id} is still running.`);
		if (agent.status !== "interrupted") {
			throw new Error(
				`Sub-agent ${id} is ${agent.status} — only interrupted agents can be continued ` +
					"(use subagent_followup for done/error/timeout agents).",
			);
		}
		if (this.runningCount() >= this.options.maxConcurrent) {
			throw new Error(
				`Concurrency limit reached (${this.options.maxConcurrent} running sub-agents). Wait for one to finish or cancel one.`,
			);
		}
		// Read-only agents share the project directory — nothing to verify.
		if (agent.branch) {
			if (!existsSync(agent.worktreePath)) {
				agent.status = "error";
				agent.error = "Worktree missing — nothing to continue.";
				this.deleteMeta(agent);
				throw new Error(`Worktree for ${id} is gone.`);
			}
			if (!existsSync(join(agent.worktreePath, ".git"))) {
				agent.status = "error";
				agent.error = "Worktree is not a git checkout — nothing to continue.";
				this.deleteMeta(agent);
				throw new Error(`Worktree for ${id} is not a git checkout.`);
			}
			let branchOk = true;
			try {
				git(["rev-parse", "--verify", agent.branch], agent.worktreePath);
			} catch {
				branchOk = false;
			}
			if (!branchOk) {
				agent.status = "error";
				agent.error = `Branch ${agent.branch} removed — nothing to continue.`;
				this.deleteMeta(agent);
				throw new Error(`Branch ${agent.branch} for ${id} is gone.`);
			}
		}
		agent.status = "running";
		delete agent.error;
		delete agent.endTime;
		agent.startTime = Date.now();
		delete agent.result;
		delete agent.commitHash;
		const taskText = agent.branch
			? [
					"[RESUMED TASK] This task was started in a previous session but interrupted before completion.",
					"The worktree already contains any partial work from that attempt (possibly uncommitted).",
					"Before acting, inspect the current state: git status, git diff, and the files involved.",
					"Then complete the original task:",
					"",
					agent.task,
				].join("\n")
			: [
					"[RESUMED TASK] This read-only task was started in a previous session but interrupted before completion.",
					"Complete the original task:",
					"",
					agent.task,
				].join("\n");
		this.launch(agent, {
			taskText,
			timeoutMs: undefined,
		});
		return agent;
	}

	/**
	 * Run a sub-agent to completion inside its worktree: host progress,
	 * abort/timeout handling, auto-commit, failure salvage, and completion
	 * notification. Shared by spawn(), followup(), and continueAgent().
	 */
	private launch(agent: SubAgent, options: { taskText: string; timeoutMs: number | undefined }): void {
		const { id } = agent;
		const projectRoot = agent.projectRoot;
		const worktreePath = agent.worktreePath;
		const branch = agent.branch;
		const depth = agent.depth;

		// Resolve the model up front so a missing model never surfaces as a
		// confusing TypeError deep inside the run. Instead, set a clear error
		// and leave the agent in a clean terminal "error" state.
		const model = this.resolveModel(agent.model) ?? this.resolveModel();
		if (!model) {
			agent.status = "error";
			agent.error = agent.model
				? `Model ${agent.model} is unavailable and no session model is selected as a fallback.`
				: "No model is selected in the session — cannot run the sub-agent.";
			this.cleanupFailedRun(agent);
			this.notifyStartFailure(agent);
			return;
		}

		const runHandle = this.onRunStarted(agent);
		(agent as SubAgent & { runHandle?: unknown }).runHandle = runHandle;
		this.writeMeta(agent);

		const abortController = new AbortController();
		// Distinguishes an explicit cancel()/shutdown() abort from the timeout
		// abort. Without this, a timeout firing between the explicit abort and
		// the run handler resuming would flip a deliberate cancel into a
		// "timeout" (which keeps partial work instead of discarding it).
		let explicitCancel = false;
		agent.abort = async () => {
			explicitCancel = true;
			abortController.abort();
		};

		const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
		// Distinguishes a timeout abort from an explicit cancel() in the run handler.
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			abortController.abort();
		}, timeoutMs);

		agent.promise = (async () => {
			try {
				const subagentResult = await this.runSubagent({
					id,
					task: options.taskText,
					readOnly: agent.readOnly ?? false,
					cwd: worktreePath,
					branch,
					projectRoot,
					model,
					depth,
					maxDepth: this.options.maxDepth,
					subagentInstructions: this.options.subagentInstructions,
					childToolsetFactory: (childDepth, spawnerId) => this.buildChildToolset(childDepth, spawnerId),
					onProgress: (_text) => {},
					signal: abortController.signal,
				});
				agent.usage = subagentResult.usage;

				if (abortController.signal.aborted) {
					if (timedOut && !explicitCancel) {
						agent.status = "timeout";
						agent.error = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
						this.cleanupFailedRun(agent);
					} else {
						agent.status = "cancelled";
						agent.error = "Cancelled";
						// Explicit cancel = deliberate discard: remove worktree + branch
						// (matches the subagent_cancel tool contract). Read-only
						// agents share the project directory — nothing to remove.
						if (agent.branch) cleanupWorktree(projectRoot, id, true);
						this.deleteMeta(agent);
					}
				} else if (subagentResult.stopReason === "error") {
					agent.status = "error";
					agent.error = subagentResult.errorMessage ?? "Sub-agent run failed";
					this.cleanupFailedRun(agent);
				} else if (agent.branch) {
					// Auto-commit the worktree (write path)
					const commit = commitWorktree(worktreePath, id, agent.task, this.options.gitName, this.options.gitEmail);
					if (!commit.ok) {
						agent.status = "error";
						agent.error = `Commit failed: ${commit.reason}`;
					} else {
						agent.status = "done";
						agent.commitHash = commit.hash ?? undefined;
						agent.result = subagentResult.result;
						// Persist the terminal state: after a pi restart this agent must
						// come back as "done" (reviewable/mergeable), not mislabeled
						// "interrupted".
						this.writeMeta(agent);
					}
				} else {
					// Read-only path: the report is the entire deliverable.
					agent.status = "done";
					agent.result = subagentResult.result;
				}
			} catch (error) {
				agent.status = "error";
				agent.error = error instanceof Error ? error.message : String(error);
				this.cleanupFailedRun(agent);
			} finally {
				clearTimeout(timeout);
				agent.endTime = Date.now();
				this.onRunSettled(agent, runHandle);
				this.notifyCompletion(agent);
				this.resolvePending(id);
				this.afterSettle();
			}
		})();
	}

	/** Cancel a running (or queued) sub-agent and clean up. */
	async cancel(id: string): Promise<SubAgent> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "pending") {
			agent.status = "cancelled";
			agent.error = "Cancelled while queued";
			agent.endTime = Date.now();
			this.resolvePending(id);
			this.afterSettle();
			return agent;
		}
		if (agent.status === "running") {
			await agent.abort?.();
			await agent.promise;
		}
		// The run handler already cleans up on cancel; this is idempotent
		// insurance so the subagent_cancel contract ("clean up its worktree")
		// always holds.
		if (agent.status === "cancelled" && agent.branch) {
			cleanupWorktree(agent.projectRoot, agent.id, true);
		}
		return agent;
	}

	/**
	 * Failure-path cleanup (error/timeout).
	 *
	 * Policy: first try to commit whatever partial work the agent left in its
	 * worktree, then check whether the branch carries commits the main HEAD
	 * doesn't. If it does, KEEP the worktree + branch so the user can review
	 * and salvage the partial work (status stays 'error'/'timeout'). If the
	 * agent produced no commits, remove worktree + branch so failed runs don't
	 * leak .pi/subagent/<id> directories and pi/subagent/<id> branches forever.
	 */
	private cleanupFailedRun(agent: SubAgent): void {
		if (!agent.branch) return; // read-only agents share the project dir — never commit or clean there
		try {
			try {
				const commit = commitWorktree(
					agent.worktreePath,
					agent.id,
					agent.task,
					this.options.gitName,
					this.options.gitEmail,
				);
				if (commit.ok && commit.hash) agent.commitHash = commit.hash;
			} catch {
				/* best effort — worktree may already be gone */
			}
			if (hasBranchCommits(agent.projectRoot, agent.id)) {
				agent.error =
					`${agent.error ?? "Sub-agent run failed"} ` +
					`(partial work kept on branch ${agent.branch} — use review, then merge or reject)`;
				// Partial work survives on the branch — persist the terminal status
				// so a restart restores it faithfully instead of "interrupted".
				this.writeMeta(agent);
			} else {
				cleanupWorktree(agent.projectRoot, agent.id, true);
				this.deleteMeta(agent);
			}
		} catch {
			/* cleanup is best-effort and must not mask the original error */
		}
	}

	/**
	 * Remove worktrees + branches for agents in terminal states (cancelled,
	 * rejected, merged) whose on-disk artifacts are still present — e.g. after
	 * a crash or a missed cleanup. Best-effort.
	 */
	sweep(): void {
		for (const agent of this.agents.values()) {
			if (agent.status === "cancelled" || agent.status === "rejected" || agent.status === "merged") {
				try {
					if (agent.branch) cleanupWorktree(agent.projectRoot, agent.id, true);
					this.deleteMeta(agent);
				} catch {
					/* best-effort */
				}
			}
		}
	}

	review(id: string): string {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (!agent.branch) {
			throw new Error(`Sub-agent ${id} is report-only (readOnly) — no diff; read its report via the list tool.`);
		}
		return getDiff(agent.projectRoot, id);
	}

	merge(id: string): { agent: SubAgent; message: string } {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (!agent.branch) throw new Error(`Sub-agent ${id} is report-only (readOnly) — nothing to merge.`);
		if (agent.status === "running" || agent.status === "pending")
			throw new Error(`Sub-agent ${id} is still ${agent.status}.`);
		const result = mergeBranch(agent.projectRoot, id, {
			stashPolicy: "auto",
			onCommitFailure: "keep-merge",
			description: agent.task,
		});
		if (result.success) {
			agent.status = "merged";
			cleanupWorktree(agent.projectRoot, id, true);
			this.deleteMeta(agent);
			let message = `Merged ${agent.branch} into the current branch.`;
			if (result.stashWarning) message += `\n! ${result.stashWarning}`;
			return { agent, message };
		}
		if (result.hasConflicts) {
			let message =
				`Merge conflicts in:\n${result.conflictFiles}\n` +
				`The branch ${agent.branch} is retained. Resolve manually or reject "${id}".`;
			// The pre-merge stash may have failed to pop — the user must know
			// their uncommitted changes are still stashed.
			if (result.stashWarning) message += `\n! ${result.stashWarning}`;
			return { agent, message };
		}
		return { agent, message: `Merge failed: ${result.error}. The branch ${agent.branch} is retained.` };
	}

	reject(id: string): { agent: SubAgent; message: string } {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "running" || agent.status === "pending") {
			throw new Error(`Sub-agent ${id} is still ${agent.status} — cancel it first.`);
		}
		agent.status = "rejected";
		if (agent.branch) {
			cleanupWorktree(agent.projectRoot, id, true);
			this.deleteMeta(agent);
			return { agent, message: `Rejected ${id}: worktree removed and branch ${agent.branch} deleted.` };
		}
		return { agent, message: `Rejected ${id} (report-only agent — nothing to clean up).` };
	}

	ensureGit(): string {
		ensureGitRepo(this.options.projectRoot);
		return `Git repository ready at ${this.options.projectRoot}`;
	}

	/** Abort every running sub-agent (session shutdown). */
	async shutdown(): Promise<void> {
		for (const p of this.list().filter((a) => a.status === "pending")) {
			p.status = "cancelled";
			p.error = "Session shutdown";
			p.endTime = Date.now();
			this.resolvePending(p.id);
		}
		const running = this.list().filter((a) => a.status === "running");
		await Promise.allSettled(running.map((a) => a.abort?.()));
		await Promise.allSettled(running.map((a) => a.promise));
		// Aborted agents land in 'cancelled' and their run handler cleans up;
		// this pass is belt-and-braces for anything missed.
		for (const agent of this.list()) {
			if (agent.status === "cancelled" && agent.branch) {
				try {
					cleanupWorktree(agent.projectRoot, agent.id, true);
				} catch {
					/* best-effort */
				}
			}
		}
	}
}
