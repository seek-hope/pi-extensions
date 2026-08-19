/**
 * Sub-agent core types (runtime-agnostic — no model/tool/UI dependencies).
 */

export type SubAgentStatus =
	| "pending"
	| "running"
	| "done"
	| "error"
	| "cancelled"
	| "timeout"
	| "merged"
	| "rejected"
	| "interrupted";

export interface SubAgentUsage {
	input: number;
	output: number;
	cost: number;
}

export interface SubAgent {
	id: string;
	task: string;
	status: SubAgentStatus;
	depth: number;
	/** Id of the agent that spawned this one (undefined for top-level spawns). */
	parentId?: string;
	/**
	 * Branch the agent commits to (write path). Empty string for readOnly
	 * agents — they share the project directory and produce a report only.
	 */
	branch: string;
	/**
	 * Filesystem root the agent runs in: the dedicated worktree (write path)
	 * or the project root itself (readOnly path — OS-style shared read access).
	 */
	worktreePath: string;
	projectRoot: string;
	startTime: number;
	endTime?: number;
	/**
	 * Read-only mode: bash is write-gated and edit/write tools are absent,
	 * so the agent mechanically cannot modify files. ReadOnly agents run in
	 * the project directory (no worktree, no commit, no review) — their
	 * report is the entire deliverable.
	 */
	readOnly?: boolean;
	/**
	 * Ids of agents that must reach `done` before this one starts. While
	 * unmet the agent stays `pending` (no concurrency slot, no worktree).
	 * A dependency ending in error/cancelled/timeout/rejected cascades:
	 * the pending agent is cancelled. `interrupted` deps keep it waiting
	 * (a crash resume may still complete them).
	 */
	dependsOn?: string[];
	/** Completion notifications suppressed (parallel fan-out collects explicitly). */
	silent?: boolean;
	/** Final report from the sub-agent (last assistant message). */
	result?: string;
	error?: string;
	commitHash?: string;
	model?: string;
	usage?: SubAgentUsage;
	/** Abort the in-process run. */
	abort?: () => Promise<void>;
	/** Resolves when the run reaches a terminal state. */
	promise?: Promise<void>;
}

export interface SpawnSubagentOptions {
	task: string;
	/**
	 * Read-only path (default false): the agent shares the project directory
	 * (no worktree/commit/review ceremony) and mechanically cannot write —
	 * use for research, analysis, and Q&A tasks. Write path (default):
	 * dedicated git worktree + auto-commit + review/merge.
	 */
	readOnly?: boolean;
	/** Model ref override (provider/id form, resolved by the host). */
	model?: string;
	/** Run timeout in ms (default from manager options). */
	timeoutMs?: number;
	/** Depth in the spawn tree (0 = spawned by the main session). */
	depth?: number;
	/** Id of the spawning agent (for tree tracking). */
	parentId?: string;
	/**
	 * Ids this agent depends on: it stays `pending` until every one of them
	 * reaches `done`, then starts with their reports injected into its
	 * prompt. This is the LEGO connector for composing workflows:
	 * single agents and parallel batches are the blocks, dependsOn is the
	 * execution ordering between them.
	 */
	dependsOn?: string[];
	/** Suppress the completion notification (parallel fan-out collects explicitly). */
	silent?: boolean;
}

/** A resolved model reference (provider/id). */
export interface ResolvedModel {
	provider: string;
	id: string;
}

/**
 * The request handed to the host's run adapter for ONE model-loop execution
 * inside the agent's worktree (or the project root for readOnly agents).
 * `task` is the full prompt text (followup/resume/dependency preambles
 * already composed by the manager).
 */
export interface SubagentRunRequest {
	id: string;
	task: string;
	readOnly: boolean;
	/** Working directory — the agent's filesystem root. */
	cwd: string;
	/** Branch name ("" for readOnly agents). */
	branch: string;
	projectRoot: string;
	model: ResolvedModel;
	depth: number;
	maxDepth: number;
	/** Additional developer instructions appended to the agent prompt. */
	subagentInstructions: string | undefined;
	/**
	 * Recursive child toolset factory, provided by the host. The run adapter
	 * decides whether to include it (typically skipped when depth+1 >= maxDepth).
	 */
	childToolsetFactory: (depth: number, spawnerId: string) => unknown[];
	/** Progress callback for live tool activity (todo progress etc.). */
	onProgress: (text: string) => void;
	signal: AbortSignal;
}

/** The outcome of one model-loop run, normalized for the manager's state machine. */
export interface SubagentRunResult {
	/** Final assistant text (the report). */
	result: string;
	usage: SubAgentUsage;
	stopReason: string;
	errorMessage?: string;
}
