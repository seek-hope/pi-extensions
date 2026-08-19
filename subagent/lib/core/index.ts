/**
 * `@earendil-works/pi-subagent-core` — runtime-agnostic sub-agent core:
 * git worktree isolation (write path), shared-directory read-only path,
 * dependsOn DAG scheduling, lifecycle state machine, crash-resume
 * metadata, followup re-tasking, and spawn-tree tracking.
 *
 * The host supplies the model loop through `SubagentManager`'s protected
 * template methods.
 */

export { SubagentManager, type SubagentManagerOptions } from "./manager.ts";
export type {
	ResolvedModel,
	SpawnSubagentOptions,
	SubAgent,
	SubAgentStatus,
	SubAgentUsage,
	SubagentRunRequest,
	SubagentRunResult,
} from "./types.ts";
export {
	branchName,
	cleanupWorktree,
	commitWorktree,
	createWorktree,
	ensureGitRepo,
	getDiff,
	git,
	hasBranchCommits,
	mergeBranch,
	safeId,
	subagentWorktreePath,
} from "./worktree.ts";
