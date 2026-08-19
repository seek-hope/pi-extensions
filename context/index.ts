/**
 * context (pi-ex): context-window stewardship extension.
 *
 * Currently provides context pruning (bulky old read-only tool outputs are
 * replaced with metadata-only stubs before each LLM call); the fork
 * compaction pipeline, recall tools, and uncertainty protocol migrate here
 * from pi-ex core as the migration proceeds.
 *
 * Prune settings come from the fork host bridge (SettingsManager) when the
 * session provides one; otherwise the defaults apply.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getForkHost } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRUNE_SETTINGS, pruneContextMessages, type PruneSettings } from "./lib/prune.ts";
import { createRecallToolDefinitions } from "./lib/recall.ts";

export default function (pi: ExtensionAPI) {
	pi.on("context", (event, ctx) => {
		const host = getForkHost(ctx.sessionManager);
		const settings: PruneSettings = host?.settingsManager.getPruneSettings() ?? DEFAULT_PRUNE_SETTINGS;
		const { messages, prunedCount } = pruneContextMessages(event.messages, settings);
		if (prunedCount === 0) return;
		return { messages };
	});

	// recall/recall_checkpoints: archive retrieval (full originals live in the
	// session store; pruned outputs are reachable via the toolCallId lookup).
	// recall.enabled is enforced per-execute (registration itself is static).
	for (const definition of createRecallToolDefinitions()) {
		const originalExecute = definition.execute;
		definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
			const host = getForkHost(ctx.sessionManager);
			if (host && !host.settingsManager.getRecallEnabled()) {
				return {
					content: [{ type: "text", text: "recall is disabled (recall.enabled = false)" }],
					details: {},
					isError: true,
				};
			}
			return originalExecute(toolCallId, params, signal, onUpdate, ctx);
		};
		pi.registerTool(definition);
	}
}
