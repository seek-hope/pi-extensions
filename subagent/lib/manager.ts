/**
 * SubagentManager (pi coding-agent adapter) — the host-side subclass of the
 * runtime-agnostic `@earendil-works/pi-subagent-core` manager. Supplies the
 * model loop (AgentHarness runner), the recursive child toolset, todo
 * progress bookkeeping, the steering inbox, and the workflow-level
 * completion wake. Everything else — worktree lifecycle, DAG scheduling,
 * meta persistence, cancel/timeout races, auto-commit, review/merge/reject
 * — lives in the core.
 *
 * Write path: spawn → worktree + run → auto-commit → review/merge/reject.
 * Read-only path: spawn → run in the shared project dir → report only.
 * Recursive delegation: children spawn through the same manager with depth+1.
 */

import type { Agent, AgentHarnessTool, AgentTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import {
	SubagentManager as CoreSubagentManager,
	type ResolvedModel,
	type SubAgent,
	type SubagentRunRequest,
	type SubagentRunResult,
} from "./core/index.ts";
import { Type } from "typebox";

import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { stateFor } from "../../shared/todo-state.ts";
import { runSubagent } from "./runner.ts";
import type { SpawnSubagentOptions } from "./types.ts";

/** Minimal session surface the manager needs (built by the extension entry). */
export interface SubagentContext {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly modelRuntime: ModelRuntime;
	/** The live extension context (todo bus, UI). */
	readonly extCtx: ExtensionContext;
	getModel(): Model<any> | undefined;
	sendFollowUp?(text: string): void;
}

export interface SubagentManagerOptions {
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

export class SubagentManager extends CoreSubagentManager {
	private readonly ctx: SubagentContext;
	/** Active todo entry per running agent id. */
	private readonly runTodoIds = new Map<string, string>();

	constructor(ctx: SubagentContext, options: SubagentManagerOptions) {
		super({ projectRoot: ctx.cwd, ...options });
		this.ctx = ctx;
	}

	// ========================================================================
	// Core seams
	// ========================================================================

	private resolveConcreteModel(modelRef?: string) {
		if (!modelRef) return this.ctx.getModel();
		const slash = modelRef.indexOf("/");
		if (slash > 0) {
			const exact = this.ctx.modelRuntime.getModel(modelRef.slice(0, slash), modelRef.slice(slash + 1));
			if (exact) return exact;
			// Fall through: some catalog ids contain a slash themselves
			// (vendor/name) — try the whole string as a bare id.
		}
		// Bare id: search every provider
		for (const provider of this.ctx.modelRuntime.getProviders()) {
			const model = this.ctx.modelRuntime.getModel(provider.id, modelRef);
			if (model) return model;
		}
		return undefined;
	}

	protected override resolveModel(modelRef?: string): ResolvedModel | undefined {
		const model = this.resolveConcreteModel(modelRef);
		return model ? { provider: model.provider, id: model.id } : undefined;
	}

	private todoStore() {
		return stateFor(this.ctx.extCtx).store;
	}

	protected override async runSubagent(request: SubagentRunRequest): Promise<SubagentRunResult> {
		const model = this.ctx.modelRuntime.getModel(request.model.provider, request.model.id) ?? this.ctx.getModel();
		if (!model) {
			throw new Error(`Model ${request.model.provider}/${request.model.id} is unavailable.`);
		}
		const todoId = this.runTodoIds.get(request.id);
		return runSubagent({
			id: request.id,
			task: request.task,
			readOnly: request.readOnly,
			cwd: request.cwd,
			branch: request.branch,
			projectRoot: request.projectRoot,
			modelRuntime: this.ctx.modelRuntime,
			model,
			depth: request.depth,
			maxDepth: request.maxDepth,
			childTools: (childDepth, spawnerId) =>
				request.childToolsetFactory(childDepth, spawnerId) as AgentHarnessTool<ExecutionToolContext>[],
			subagentInstructions: request.subagentInstructions,
			onAgentCreated: (agent) => this.liveAgents.set(request.id, agent),
			onProgress: (text) => {
				request.onProgress(text);
				if (todoId) this.todoStore().setProgress(request.id, "running", text);
			},
			signal: request.signal,
		});
	}

	protected override onRunStarted(agent: SubAgent): unknown {
		const todoId = this.todoStore().addItem(`• ${agent.task}`) ?? null;
		if (todoId) this.runTodoIds.set(agent.id, todoId);
		return todoId;
	}

	protected override onRunSettled(agent: SubAgent, runHandle: unknown): void {
		this.liveAgents.delete(agent.id);
		const todoId = (runHandle as string | null | undefined) ?? null;
		this.runTodoIds.delete(agent.id);
		if (!todoId) return;
		const icon = agent.status === "done" ? "✓" : agent.status === "cancelled" ? "✗" : "!";
		// Full task text — the widget wraps instead of truncating.
		const label = `• ${agent.task} — ${icon} ${agent.status}`;
		const store = this.todoStore();
		store?.updateItemById(todoId, agent.status === "done" ? "completed" : "cancelled", label);
		store?.clearProgress(agent.id);
		// Programmatic items are excluded from the store's auto-clear,
		// so remove the entry ourselves after the completed state has
		// been visible for a moment — otherwise it lingers forever.
		if (store) {
			const timer = setTimeout(() => store.removeItemById(todoId), 2_000);
			timer.unref?.();
		}
	}

	protected override notifyCompletion(agent: SubAgent): void {
		const ui = this.ctx.extCtx.hasUI ? this.ctx.extCtx.ui : undefined;
		if (agent.status === "done") {
			ui?.notify(`✓ Sub-agent ${agent.id} completed`, "info");
		} else {
			ui?.notify(`! Sub-agent ${agent.id} ${agent.status}: ${agent.error ?? ""}`, "warning");
		}
	}

	/**
	 * Workflow-level wake: no per-agent notifications — when the last
	 * running/pending agent settles, the parent gets ONE message and
	 * collects reports via subagent_list.
	 */
	protected override onAllSettled(agents: SubAgent[]): void {
		const lines = ["[All sub-agents have settled]"];
		for (const a of agents) {
			const marker = a.status === "done" ? "✓" : "✗";
			const where = a.branch
				? ` branch ${a.branch}${a.commitHash ? ` (${a.commitHash.slice(0, 8)})` : ""}`
				: " (report-only)";
			lines.push(`${marker} ${a.id} [${a.status}]${where} — ${a.task.substring(0, 120)}`);
		}
		lines.push(
			"Collect reports with subagent_list. For write-path agents: subagent_review to inspect the diff, then subagent_merge or subagent_reject.",
		);
		this.ctx.sendFollowUp?.(lines.join("\n"));
	}

	/** Live in-process Agent handles for steering (running agents only). */
	private readonly liveAgents = new Map<string, Agent>();

	protected override deliverSteering(agent: SubAgent, text: string): void {
		const live = this.liveAgents.get(agent.id);
		if (!live) throw new Error(`Sub-agent ${agent.id} has no live run to steer`);
		live.steer({ role: "user", content: text, timestamp: Date.now() });
	}

	// ========================================================================
	// Recursive child toolset (Agent runtime tools, not session tools)
	// ========================================================================

	protected override buildChildToolset(depth: number, spawnerId: string): unknown[] {
		const manager = this;
		const spawnSchema = Type.Object({
			task: Type.String({ description: "Task description for the sub-agent" }),
			readOnly: Type.Optional(
				Type.Boolean({
					description:
						"Read-only path: shares the project directory, mechanically cannot write (no edit/write tools, bash is write-gated), report is the entire deliverable. Use for research/analysis subtasks. Default false: dedicated git worktree + full tools.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model override as provider/id. Prefer a cheaper/faster leaf model for small, well-scoped subtasks; keep the parent model for orchestration-heavy work.",
				}),
			),
			timeoutMs: Type.Optional(Type.Number({ description: "Max runtime in ms" })),
		});
		const waitSchema = Type.Object({ id: Type.String({ description: "Sub-agent id" }) });
		const listSchema = Type.Object({});

		const spawnTool: AgentTool<typeof spawnSchema> = {
			name: "subagent_spawn",
			label: "Spawn Sub-agent",
			description:
				"Spawn a sub-agent for an independent subtask. Write path (default): own git worktree, full tools, changes committed for your review. " +
				"Read-only path (readOnly: true): shares your directory, cannot write, returns a report. " +
				"Fire-and-forget: there is no nested wait — completion is reported back to you.",
			parameters: spawnSchema,
			async execute(_id, params: { task: string; readOnly?: boolean; model?: string; timeoutMs?: number }) {
				const agent = await manager.spawn({
					task: params.task,
					readOnly: params.readOnly,
					model: params.model,
					timeoutMs: params.timeoutMs,
					depth,
					parentId: spawnerId,
					silent: true,
				} as SpawnSubagentOptions);
				return {
					content: [
						{
							type: "text",
							text: `Sub-agent ${agent.id} started (${agent.branch ? `worktree: ${agent.worktreePath}` : "read-only, in-place"}).`,
						},
					],
					details: { id: agent.id },
				};
			},
		};
		const listTool: AgentTool<typeof listSchema> = {
			name: "subagent_list",
			label: "List Sub-agents",
			description: "List all sub-agents and their status.",
			parameters: listSchema,
			async execute() {
				const lines = manager.list().map((a) => `  ${a.id}: ${a.status} — ${a.task.substring(0, 60)}`);
				return {
					content: [{ type: "text", text: lines.length ? `Sub-agents:\n${lines.join("\n")}` : "No sub-agents." }],
					details: {},
				};
			},
		};
		const cancelTool: AgentTool<typeof waitSchema> = {
			name: "subagent_cancel",
			label: "Cancel Sub-agent",
			description: "Cancel a running or queued sub-agent and clean up.",
			parameters: waitSchema,
			async execute(_id, params: { id: string }) {
				await manager.cancel(params.id);
				const agent = manager.get(params.id);
				return {
					content: [{ type: "text", text: `Sub-agent ${params.id}: ${agent?.status ?? "cancelled"}.` }],
					details: {},
				};
			},
		};
		return [spawnTool, listTool, cancelTool];
	}
}
