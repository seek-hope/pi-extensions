/**
 * fork-bash-gate (pi-ex): block bash commands that duplicate pi's proper
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
		// Let bg-convertible commands through: core's spawnBg conversion turns
		// them into background tasks instead of blocking.
		const classification = classifyBashGateCommand(command, match.rule.name);
		if (classification.kind === "bg") return;
		return { block: true, reason: formatGateResponse(match) };
	});
}
