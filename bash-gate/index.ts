/**
 * bash-gate (pi-ex): block bash commands that duplicate pi's proper
 * tools (cat → read, grep -r → grep, etc.), migrated from pi-ex core's
 * bash.ts gate.
 *
 * Runs as an early tool_call layer: matches are blocked with the gate
 * response teaching the model the right tool. Background-convertible
 * commands (kind "bg": leading sleep, polling loops, watch) are NOT blocked
 * — core bash.ts's spawnBg conversion handles those.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkBashGate, classifyBashGateCommand, formatGateResponse } from "./lib/bash-gate.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: string }).command ?? "";
		const match = checkBashGate(command);
		if (!match) return;
		// Sleep-like commands (leading sleep, polling loops, watch) point at the
		// task/wait tools instead of blocking with the generic gate response.
		const classification = classifyBashGateCommand(command, match.rule.name);
		if (classification.kind === "bg") {
			return {
				block: true,
				reason:
					"[BLOCKED] Long-running or polling command. " +
					"Run it as a background task with bg_spawn (you get a task ID + log file, and the completion notice wakes you), " +
					"or use the wait tool to rest the turn until it finishes.",
			};
		}
		return { block: true, reason: formatGateResponse(match) };
	});
}
