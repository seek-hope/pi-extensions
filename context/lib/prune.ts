/**
 * Context pruning — deterministic pre-compaction cleanup of bulky tool
 * outputs.
 *
 * Runs as a context-view transformation (the session store keeps full output;
 * retrieval is always possible via the recall tool). Large old outputs from
 * read-mostly tools are replaced with short stubs, shrinking every subsequent
 * LLM call and often deferring or avoiding compaction entirely.
 *
 * Rules:
 * - Only tool results from read-mostly tools (read, bash, grep, find, ls).
 *   Note: bash is not strictly read-only — `npm install`, builds, and test
 *   runs mutate the environment — but their large outputs are overwhelmingly
 *   logs, and the recall tool can always retrieve the original; that asymmetry
 *   (bulky output, cheap recoverability) is why bash qualifies.
 * - Never the most recent `keepRecentToolResults` eligible (over-threshold) outputs.
 * - Never error results (diagnostics are high-value) or results with images.
 * - Only results at or above `minPrunableTokens`.
 *
 * Pruned outputs lose their content entirely — the stub carries metadata only
 * (tool name, size, line count, recall handle). Retrieval is via the recall
 * tool's `toolCallId` direct lookup, which returns the full original from the
 * session archive.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "./utils.ts";

export interface PruneSettings {
	enabled?: boolean; // default: true
	keepRecentToolResults?: number; // default: 5 - never prune the N most recent eligible (over-threshold) outputs
	minPrunableTokens?: number; // default: 1000 - only prune results at or above this size
}

export const DEFAULT_PRUNE_SETTINGS: Required<PruneSettings> = {
	enabled: true,
	keepRecentToolResults: 5,
	minPrunableTokens: 1000,
};

// bash is included deliberately: its output is usually logs (bulky, and
// recoverable via recall), even though the command itself may mutate state.
const PRUNABLE_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);

const PRUNE_MARKER = "[pruned ";

export interface PruneResult {
	messages: AgentMessage[];
	prunedCount: number;
	prunedTokens: number;
}

interface ToolResultText {
	text: string;
	hasImage: boolean;
}

function toolResultText(message: AgentMessage): ToolResultText | undefined {
	if (message.role !== "toolResult") return undefined;
	const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
	if (!Array.isArray(content)) return undefined;
	let text = "";
	let hasImage = false;
	for (const part of content) {
		if (part.type === "image") hasImage = true;
		else if (part.type === "text" && part.text) text += part.text;
	}
	return { text, hasImage };
}

export function pruneContextMessages(messages: AgentMessage[], settings?: PruneSettings): PruneResult {
	const opts = { ...DEFAULT_PRUNE_SETTINGS, ...settings };
	if (!opts.enabled || messages.length === 0) {
		return { messages, prunedCount: 0, prunedTokens: 0 };
	}

	// Eligible = prunable tool, not an error, no images, not already pruned,
	// and over the size threshold. Only eligible outputs consume recency
	// protection: the N most recent eligible outputs stay intact.
	interface Eligible {
		index: number;
		tokens: number;
		lines: number;
		toolName: string;
		toolCallId: string;
	}
	const eligible: Eligible[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult") continue;
		const toolName = (message as { toolName?: string }).toolName ?? "";
		if (!PRUNABLE_TOOLS.has(toolName)) continue;
		if ((message as { isError?: boolean }).isError === true) continue;
		const result = toolResultText(message);
		if (!result || result.hasImage) continue;
		if (result.text.startsWith(PRUNE_MARKER)) continue;
		const tokens = estimateTextTokens(result.text);
		if (tokens < opts.minPrunableTokens) continue;
		eligible.push({
			index: i,
			tokens,
			lines: result.text.includes("\n") ? result.text.split("\n").length : 1,
			toolName,
			toolCallId: (message as { toolCallId?: string }).toolCallId ?? "",
		});
	}

	const pruneBefore = Math.max(0, eligible.length - opts.keepRecentToolResults);
	const toPrune = new Map(eligible.slice(0, pruneBefore).map((e) => [e.index, e]));

	let prunedCount = 0;
	let prunedTokens = 0;
	const out: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const e = toPrune.get(i);
		if (!e) {
			out.push(message);
			continue;
		}

		// Metadata-only stub: no content is kept. The short id is a prefix of
		// the toolCallId — recall's toolCallId parameter accepts prefixes and
		// returns the full original from the session archive.
		const shortId = e.toolCallId.slice(0, 8);
		const stub =
			`[pruned ${e.toolName} output — ~${e.tokens} tok, ${e.lines} line${e.lines === 1 ? "" : "s"}. ` +
			`Full output: recall with toolCallId "${shortId}".]`;

		// Replace only the FIRST text part with the stub and drop the remaining
		// text parts (they were slices of the same pruned output — replacing each
		// with the full stub would duplicate it N times while the token
		// accounting above counts it once). Non-text parts (images etc.) are
		// kept as-is.
		const toolResult = message as { content: Array<{ type: string; text?: string }> };
		let stubPlaced = false;
		const newContent: Array<{ type: string; text?: string }> = [];
		for (const part of toolResult.content) {
			if (part.type === "text") {
				if (!stubPlaced) {
					newContent.push({ ...part, text: stub });
					stubPlaced = true;
				}
				// else: drop — part of the same pruned output
			} else {
				newContent.push(part);
			}
		}
		out.push({ ...message, content: newContent } as AgentMessage);
		prunedCount++;
		prunedTokens += e.tokens - estimateTextTokens(stub);
	}

	return { messages: out, prunedCount, prunedTokens };
}
