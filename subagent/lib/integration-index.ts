/**
 * Sub-agent integration — in-process multi-agent delegation with git worktree
 * isolation, as a core integration.
 */
import type { ToolDefinition } from "../../extensions/types.ts";
import type { CoreIntegration, CoreIntegrationContext } from "../types.ts";
import { SubagentManager } from "./manager.ts";
import { createSubagentToolDefinitions } from "./tools.ts";

export class SubagentIntegration implements CoreIntegration {
	readonly id = "subagent";
	readonly manager: SubagentManager;

	private readonly ctx: CoreIntegrationContext;

	constructor(ctx: CoreIntegrationContext) {
		this.ctx = ctx;
		this.manager = new SubagentManager(ctx, {
			maxDepth: ctx.settingsManager.getSubagentsMaxDepth(),
			maxConcurrent: ctx.settingsManager.getSubagentsMaxConcurrent(),
			defaultTimeoutMs: ctx.settingsManager.getSubagentsTimeoutMs(),
			gitName: ctx.settingsManager.getSubagentsGitName(),
			gitEmail: ctx.settingsManager.getSubagentsGitEmail(),
		});
	}

	getToolDefinitions(): ToolDefinition[] {
		return createSubagentToolDefinitions(this.manager);
	}

	getDefaultActiveToolNames(): string[] {
		return [
			"subagent_spawn",
			"subagent_review",
			"subagent_merge",
			"subagent_reject",
			"subagent_parallel",
			"subagent_list",
			"subagent_message",
			"subagent_cancel",
			"subagent_continue",
			"subagent_followup",
			// subagent_ensure_git stays registered but is not default-active:
			// spawning auto-ensures git, so the manual tool is rarely needed.
		];
	}

	/** /subagent command: status widget. */
	showStatusWidget(): void {
		const ui = this.ctx.getUI();
		if (!ui) return;
		const agents = this.manager.list();
		if (agents.length === 0) {
			ui.notify("No sub-agents.", "info");
			return;
		}
		const lines = ["┌─ /subagent (git worktree) ─────────────────"];
		for (const a of agents) {
			const duration = ((a.endTime ?? Date.now()) - a.startTime) / 1000;
			const icon =
				a.status === "done"
					? "✓"
					: a.status === "running"
						? "◐"
						: a.status === "merged"
							? "=>"
							: a.status === "timeout"
								? "!"
								: "✗";
			lines.push(`│ ${icon} ${a.id} [${a.status} ${duration.toFixed(0)}s] ${a.task.substring(0, 50)}`);
		}
		lines.push("└───────────────────────────────────────────");
		ui.setWidget("subagent-status", lines);
	}

	onShutdown(): void {
		void this.manager.shutdown();
		this.ctx.getUI()?.setWidget?.("subagent-status", undefined);
	}
}
