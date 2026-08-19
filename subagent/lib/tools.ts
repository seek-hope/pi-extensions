/**
 * Session-facing subagent tools (parent agent calls these).
 */
import { Type } from "typebox";
import { TimeoutParamSchema, timeoutToMs } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentManager } from "./manager.ts";
import type { SubAgent } from "./types.ts";

const MAX_REPORT_IN_LIST = 2000;

function formatAgent(a: SubAgent): string {
	const duration = ((a.endTime ?? Date.now()) - a.startTime) / 1000;
	let icon = "✗";
	if (a.status === "done") icon = "✓";
	else if (a.status === "running") icon = "◐";
	else if (a.status === "pending") icon = "◌";
	else if (a.status === "merged") icon = "=>";
	else if (a.status === "timeout") icon = "!";
	const model = a.model ? ` [${a.model}]` : "";
	const path = a.branch ? "" : " [read-only]";
	const deps = a.dependsOn?.length ? ` deps:[${a.dependsOn.join(",")}]` : "";
	let line = `${icon} ${a.id} [${a.status} ${duration.toFixed(0)}s${model}${path}${deps}] ${a.task.substring(0, 120)}`;
	if (a.status === "done" && a.result) {
		const report = a.result.trim();
		line += `\n  report: ${report.length > MAX_REPORT_IN_LIST ? `${report.slice(0, MAX_REPORT_IN_LIST)}… (truncated)` : report}`;
	}
	if (a.error) line += `\n  error: ${a.error}`;
	return line;
}

const SETTLED_HINT = "When every sub-agent has settled you get one wake-up; collect reports with subagent_list.";

export function createSubagentToolDefinitions(manager: SubagentManager): ToolDefinition[] {
	const spawnSchema = Type.Object({
		task: Type.String({ description: "Task description for the sub-agent" }),
		readOnly: Type.Optional(
			Type.Boolean({
				description:
					"Read-only path: shares the project directory, cannot write, report-only deliverable. Default false (write path: worktree + full tools + review).",
			}),
		),
		dependsOn: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Ids of agents that must complete first — this agent stays queued, then starts with their reports injected. The workflow connector.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Model override as provider/id (default: inherit parent model). Prefer a cheaper/faster leaf model for small, well-scoped leaf tasks; keep the parent model for orchestration-heavy or nuanced work.",
			}),
		),
		timeout: Type.Optional(TimeoutParamSchema),
	});
	const spawnTool: ToolDefinition<typeof spawnSchema> = {
		name: "subagent_spawn",
		label: "Spawn Sub-agent",
		description:
			"Spawn a sub-agent — one LEGO block of a workflow. Two paths: " +
			"(1) write path (default): dedicated git worktree, full tools, changes auto-committed for your review (subagent_review/merge/reject). " +
			"(2) read-only path (readOnly: true): shares the project directory like a read-only process sharing files — mechanically cannot write (no edit/write tools, bash is write-gated); no worktree/commit/review ceremony, the report is the entire deliverable. Use it for research/analysis/Q&A so nothing gets written by accident. " +
			"Compose workflows with dependsOn: the agent stays queued until every dependency completes, then starts with their reports injected into its prompt — single agents and parallel batches are the blocks, dependsOn is the execution ordering. " +
			"For small, well-scoped leaf tasks, consider a cheaper/faster model via the model param to save tokens; orchestration-heavy work keeps the parent model.",
		parameters: spawnSchema,
		async execute(_toolCallId, params) {
			try {
				const agent = await manager.spawn({
					task: params.task,
					readOnly: params.readOnly,
					dependsOn: params.dependsOn,
					model: params.model,
					timeoutMs: params.timeout ? timeoutToMs(params.timeout) : undefined,
				});
				const where = agent.branch ? `worktree: ${agent.worktreePath}` : "read-only, in the project directory";
				const state =
					agent.status === "pending" ? `queued (waiting for: ${(agent.dependsOn ?? []).join(", ")})` : "started";
				return {
					content: [
						{
							type: "text",
							text: [`Sub-agent ${agent.id} ${state} (${where}).`, SETTLED_HINT].join("\n"),
						},
					],
					details: { id: agent.id, worktree: agent.worktreePath, branch: agent.branch },
				};
			} catch (e) {
				return {
					content: [
						{ type: "text", text: `Failed to spawn sub-agent: ${e instanceof Error ? e.message : String(e)}` },
					],
					details: {},
					isError: true,
				};
			}
		},
	};

	const idSchema = Type.Object({ id: Type.String({ description: "Sub-agent id" }) });

	const reviewTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_review",
		label: "Review Sub-agent",
		description:
			"Inspect the git diff and commit log of a completed sub-agent (write path only). Use this to decide whether to merge or reject the sub-agent's work.",
		parameters: idSchema,
		async execute(_id, params) {
			try {
				const diff = manager.review(params.id);
				return { content: [{ type: "text", text: diff }], details: {} };
			} catch (e) {
				return {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					details: {},
					isError: true,
				};
			}
		},
	};

	const mergeTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_merge",
		label: "Merge Sub-agent",
		description:
			"Merge a sub-agent's branch into the main branch (write path only). If there are merge conflicts, they are reported so the main agent can resolve them.",
		parameters: idSchema,
		async execute(_id, params) {
			try {
				const { message } = manager.merge(params.id);
				return { content: [{ type: "text", text: message }], details: {} };
			} catch (e) {
				return {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					details: {},
					isError: true,
				};
			}
		},
	};

	const rejectTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_reject",
		label: "Reject Sub-agent",
		description: "Reject a sub-agent's work: delete its branch and worktree (write path) and mark it rejected.",
		parameters: idSchema,
		async execute(_id, params) {
			await manager.reject(params.id);
			return { content: [{ type: "text", text: `Sub-agent ${params.id} rejected.` }], details: {} };
		},
	};

	const parallelSchema = Type.Object({
		tasks: Type.Array(
			Type.Union([
				Type.String({ description: "Task text (write path, default settings)" }),
				Type.Object({
					task: Type.String({ description: "Task description for the sub-agent" }),
					readOnly: Type.Optional(
						Type.Boolean({ description: "Read-only path: shared directory, cannot write, report-only." }),
					),
					model: Type.Optional(Type.String({ description: "Model override as provider/id" })),
					timeout: Type.Optional(TimeoutParamSchema),
				}),
			]),
			{ description: "Tasks to run in parallel — plain strings or objects with per-task options" },
		),
		maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent (default: 5)" })),
	});
	const parallelTool: ToolDefinition<typeof parallelSchema> = {
		name: "subagent_parallel",
		label: "Parallel Sub-agents",
		description:
			"Fan out multiple sub-agents at once — the parallel LEGO block. Each runs independently: write-path agents commit to their own worktree branches (review each with subagent_review before merging); readOnly agents share the project directory and return reports. " +
			"When the whole batch (and any other agents) settles you get one wake-up; collect all reports with subagent_list. " +
			"For ordering between agents, use subagent_spawn with dependsOn instead.",
		parameters: parallelSchema,
		async execute(_id, params) {
			const limit = Math.max(1, params.maxConcurrency ?? 5);
			const queue = [...params.tasks];
			const spawned: SubAgent[] = [];
			const errors: string[] = [];
			async function worker(): Promise<void> {
				let concurrencyWaits = 0;
				for (;;) {
					const item = queue.shift();
					if (item === undefined) return;
					const spec = typeof item === "string" ? { task: item } : item;
					try {
						// NOT silent: the batch counts toward the aggregate all-settled
						// wake (this tool's collection contract).
						const agent = await manager.spawn({
							task: spec.task,
							readOnly: "readOnly" in spec ? spec.readOnly : undefined,
							model: "model" in spec ? spec.model : undefined,
							timeoutMs: "timeout" in spec && spec.timeout ? timeoutToMs(spec.timeout) : undefined,
							depth: 0,
							silent: false,
						});
						spawned.push(agent);
					} catch (e: any) {
						// Concurrency limit: another session may hold slots — wait for
						// one to free up and retry instead of dropping the task.
						// Bounded: give up after ~5 minutes of a full pool.
						if (/Max concurrent/.test(e?.message ?? "") && concurrencyWaits++ < 150) {
							queue.unshift(item);
							await new Promise((resolve) => setTimeout(resolve, 2_000));
							continue;
						}
						errors.push(`${spec.task.substring(0, 60)}: ${e?.message || e}`);
					}
				}
			}
			await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));
			const lines: string[] = [`Spawned ${spawned.length} sub-agents:`];
			for (const a of spawned) {
				lines.push(`  ${a.id}${a.branch ? "" : " [read-only]"} — ${a.task.substring(0, 60)}`);
			}
			if (errors.length > 0) {
				lines.push("", "Failed to spawn:");
				for (const e of errors) lines.push(`  ${e}`);
			}
			lines.push("", SETTLED_HINT);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ids: spawned.map((a) => a.id), errors },
			};
		},
	};

	const listSchema = Type.Object({});
	const listTool: ToolDefinition<typeof listSchema> = {
		name: "subagent_list",
		label: "List Sub-agents",
		description:
			"List all sub-agents with status, and the reports of finished ones — this is how you collect workflow results.",
		parameters: listSchema,
		async execute() {
			const agents = manager.list();
			if (agents.length === 0) {
				return { content: [{ type: "text", text: "No sub-agents." }], details: {} };
			}
			return {
				content: [{ type: "text", text: `Sub-agents:\n${agents.map(formatAgent).join("\n")}` }],
				details: {},
			};
		},
	};

	const messageSchema = Type.Object({
		id: Type.String({ description: "Sub-agent id" }),
		message: Type.String({
			description:
				"Message text. For a running agent it is injected into its loop at the next turn (course correction); for a queued (pending) agent it is appended to its start prompt.",
		}),
	});
	const messageTool: ToolDefinition<typeof messageSchema> = {
		name: "subagent_message",
		label: "Message Sub-agent",
		description:
			"Send a message to a sub-agent that is still in flight: course-correct a running agent (steered in at its next turn) or amend the prompt of a queued one. " +
			"Finished agents cannot be messaged — use subagent_followup to re-task them.",
		parameters: messageSchema,
		async execute(_id, params) {
			try {
				const agent = manager.message(params.id, params.message);
				const how =
					agent.status === "pending" ? "appended to its queued prompt" : "queued for injection at its next turn";
				return { content: [{ type: "text", text: `Message ${how} (${agent.id}).` }], details: {} };
			} catch (e) {
				return {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					details: {},
					isError: true,
				};
			}
		},
	};

	const cancelTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_cancel",
		label: "Cancel Sub-agent",
		description: "Cancel a running (or queued) sub-agent and clean up.",
		parameters: idSchema,
		async execute(_id, params) {
			const agent = await manager.cancel(params.id);
			if (!agent) {
				return { content: [{ type: "text", text: `Unknown sub-agent: ${params.id}` }], details: {}, isError: true };
			}
			return { content: [{ type: "text", text: `Sub-agent ${agent.id}: ${agent.status}.` }], details: {} };
		},
	};

	const continueTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_continue",
		label: "Continue Sub-agent",
		description:
			"Resume an interrupted sub-agent (crash survivor) in its existing worktree and branch. " +
			"The original task is re-issued with a note to inspect the partial work first. " +
			"Use after pi was restarted and subagent_list shows an 'interrupted' entry.",
		parameters: idSchema,
		async execute(_id, params) {
			const agent = await manager.continueAgent(params.id);
			return {
				content: [
					{
						type: "text",
						text: `Resumed ${agent.id} in ${agent.worktreePath}. ${SETTLED_HINT} Then subagent_review / subagent_merge / subagent_reject.`,
					},
				],
				details: { id: agent.id, worktree: agent.worktreePath, branch: agent.branch },
			};
		},
	};

	const followupSchema = Type.Object({
		id: Type.String({ description: "Sub-agent id (done/error/timeout/interrupted status)" }),
		task: Type.String({
			description:
				"New task on the agent's existing setup (branch+worktree for write path, project directory for read-only). The agent starts with a fresh context but prior commits stay on its branch — it is told to inspect git log/git status first.",
		}),
		model: Type.Optional(
			Type.String({
				description: "Model override as provider/id. Prefer a cheaper/faster leaf model for small follow-ups.",
			}),
		),
		timeout: Type.Optional(TimeoutParamSchema),
	});
	const followupTool: ToolDefinition<typeof followupSchema> = {
		name: "subagent_followup",
		label: "Re-task Sub-agent",
		description:
			"Re-task a finished sub-agent on its existing setup (fresh context; write-path agents keep their branch's commits). " +
			"Use instead of spawning a new agent when the new task builds on the agent's existing work. " +
			"Eligible statuses: done, error, timeout, interrupted.",
		parameters: followupSchema,
		async execute(_id, params) {
			const agent = await manager.followup(params.id, params.task, {
				model: params.model,
				timeoutMs: params.timeout ? timeoutToMs(params.timeout) : undefined,
			});
			const where = agent.branch ? `on its existing branch ${agent.branch}` : "read-only, in the project directory";
			return {
				content: [
					{
						type: "text",
						text: [`Re-tasked ${agent.id} ${where}.`, SETTLED_HINT].join("\n"),
					},
				],
				details: { id: agent.id, worktree: agent.worktreePath, branch: agent.branch },
			};
		},
	};

	const ensureGitTool: ToolDefinition<typeof listSchema> = {
		name: "subagent_ensure_git",
		label: "Ensure Git Repo",
		description:
			"Initialize a git repository in the project if one doesn't exist. Called automatically; rarely needed manually.",
		parameters: listSchema,
		async execute() {
			return { content: [{ type: "text", text: manager.ensureGit() }], details: {} };
		},
	};

	return [
		spawnTool as ToolDefinition,
		reviewTool as ToolDefinition,
		mergeTool as ToolDefinition,
		rejectTool as ToolDefinition,
		parallelTool as ToolDefinition,
		listTool as ToolDefinition,
		messageTool as ToolDefinition,
		cancelTool as ToolDefinition,
		continueTool as ToolDefinition,
		followupTool as ToolDefinition,
		ensureGitTool as ToolDefinition,
	];
}
