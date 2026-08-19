/**
 * ask-wait (pi-ex): the ask_user and wait tools (see lib/ask-wait.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_DESCRIPTION,
	askUserParameters,
	cancelWait,
	executeAskUser,
	scheduleWait,
	stateFor,
	WAIT_DESCRIPTION,
	waitParameters,
} from "./lib/ask-wait.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask the user",
		description: ASK_USER_DESCRIPTION,
		parameters: askUserParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => executeAskUser(params, ctx),
	});

	pi.registerTool({
		name: "wait",
		label: "Wait and rest",
		description: WAIT_DESCRIPTION,
		parameters: waitParameters,
		execute: async (_toolCallId, { timeout }, _signal, _onUpdate, ctx) => {
			const result = scheduleWait(timeout, false, ctx);
			if (!result.ok) {
				return { content: [{ type: "text", text: result.error! }], details: undefined };
			}
			return {
				content: [{ type: "text", text: result.message! }],
				details: undefined,
				// End the turn now: the wake-up arrives later (or earlier via
				// background-task completions), so the model must not keep
				// executing tools in the same turn.
				terminate: true,
			};
		},
	});

	// A pending wake-up is cancelled when any new turn starts (user input,
	// integration follow-up) or the session ends — the wake would be redundant.
	pi.on("turn_start", (_event, ctx) => {
		cancelWait(stateFor(ctx.sessionManager));
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cancelWait(stateFor(ctx.sessionManager));
	});
}
