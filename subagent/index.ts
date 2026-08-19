/**
 * subagent (pi-ex): in-process multi-agent delegation with git worktree
 * isolation, migrated from pi-ex core's SubagentIntegration.
 *
 * Tools: subagent_spawn / subagent_parallel / subagent_list /
 * subagent_review / subagent_merge / subagent_reject / subagent_message /
 * subagent_cancel / subagent_continue / subagent_followup (+ subagent_ensure_git
 * registered but not default-active upstream parity: spawning auto-ensures).
 * /subagent shows the status widget.
 *
 * Per-session manager instances are built on session_start from the fork
 * host bridge (ModelRuntime, SettingsManager) and the live ExtensionContext.
 */
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { getForkHost } from "@earendil-works/pi-coding-agent";
import { SubagentManager, type SubagentContext } from "./lib/manager.ts";
import { createSubagentToolDefinitions } from "./lib/tools.ts";

const managers = new WeakMap<SessionManager, SubagentManager>();

function managerFor(ctx: ExtensionContext): SubagentManager | undefined {
	const sm = ctx.sessionManager as unknown as SessionManager;
	const existing = managers.get(sm);
	if (existing) return existing;
	const host = getForkHost(sm);
	if (!host) return undefined;
	if (!host.settingsManager.getSubagentsEnabled()) return undefined;
	const sctx: SubagentContext = {
		cwd: ctx.cwd,
		sessionManager: sm,
		modelRuntime: host.modelRuntime,
		extCtx: ctx,
		getModel: () => ctx.model,
		sendFollowUp: (text) => ctx.sendUserMessage(text, { triggerTurn: true, deliverAs: "followUp" }),
	};
	const manager = new SubagentManager(sctx, {
		maxDepth: host.settingsManager.getSubagentsMaxDepth(),
		maxConcurrent: host.settingsManager.getSubagentsMaxConcurrent(),
		defaultTimeoutMs: host.settingsManager.getSubagentsTimeoutMs(),
		gitName: host.settingsManager.getSubagentsGitName(),
		gitEmail: host.settingsManager.getSubagentsGitEmail(),
	});
	managers.set(sm, manager);
	return manager;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const manager = managerFor(ctx);
		if (!manager) return;
		for (const definition of createSubagentToolDefinitions(manager)) {
			pi.registerTool(definition);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const manager = managers.get(ctx.sessionManager as unknown as SessionManager);
		if (manager) void manager.shutdown();
	});

	pi.registerCommand("subagent", {
		description: "Show the sub-agent status widget",
		handler: async (_args, ctx) => {
			const manager = managerFor(ctx);
			if (!manager) {
				if (ctx.hasUI) ctx.ui.notify('Sub-agents are disabled. Enable via "subagents": { "enabled": true }.', "warning");
				return;
			}
			if (!ctx.hasUI) return;
			const agents = manager.list();
			if (agents.length === 0) {
				ctx.ui.notify("No sub-agents.", "info");
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
			ctx.ui.setWidget("subagent-status", lines);
		},
	});
}
