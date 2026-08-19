/**
 * pi-ex fork compaction logic.
 *
 * Everything in this file is fork-owned: upstream pi's compaction.ts stays
 * byte-identical to upstream so `sync upstream` merges never conflict here.
 * Stable upstream helpers (completeSummarization, calculateContextTokens,
 * getLastAssistantUsage, prompts' system prompt, file-op utils) are imported
 * from the upstream files; fork semantics (round-based cut, drop-oldest-rounds
 * retry, full-fidelity serialization via fork-utils, structured-checkpoint
 * details) live here. When upstream changes compaction, reconcile
 * deliberately instead of merging blindly.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	contentText,
	isContextOverflow,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { type ContextUsageEstimate, calculateContextTokens, completeSummarization } from "@earendil-works/pi-coding-agent";
import { estimateTextTokens, serializeConversation } from "./utils.ts";
import { computeFileLists, createFileOps, type FileOperations, SUMMARIZATION_SYSTEM_PROMPT } from "@earendil-works/pi-coding-agent";

/**
 * Fork copy of upstream's private extractFileOpsFromMessage (utils.ts), extended
 * to honor the read tool's `file_path` alias for `path`. Keep in sync with
 * upstream's version when it changes.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		// The read tool accepts `file_path` as an alias for `path` — honor both.
		const rawPath = args.path ?? args.file_path;
		const path = typeof rawPath === "string" ? rawPath : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
import type { TaskContract } from "./contract.ts";
import type { ActionLedger } from "./ledger.ts";
import { extractLedgerActions, renderLedger } from "./ledger.ts";

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
	/** Structured checkpoint (v2): the task contract at compaction time. */
	contract?: TaskContract;
	/** Structured checkpoint (v2): cumulative action ledger. */
	ledger?: ActionLedger;
	/** 2 for structured checkpoints, absent for legacy narrative summaries. */
	version?: number;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return sessionEntryToContextMessages(entry)[0];
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** ID of the compaction entry appended to the session tree. */
	compactionEntryId?: string;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

/** Sum the usage of two LLM calls (e.g. the two passes of a split-turn compaction). */
/** Fraction of reserveTokens budgeted for the summary output. */
const OUTPUT_TOKEN_RESERVE_RATIO = 0.8;
/** Tokens always left below the model's context window for summarization requests. */
const SUMMARIZATION_SAFETY_TOKENS = 4096;
/** Hard cap on summarization API requests per compaction (overflow retries). */
const MAX_SUMMARIZATION_REQUESTS = 6;

export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	/** Keep the most recent N rounds (turns) unsummarized; the cut always lands on a round boundary (default 2). */
	keepRecentRounds: number;
	/** Compact when context usage exceeds this fraction of the context window. */
	thresholdRatio?: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentRounds: 2,
	thresholdRatio: 0.9,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	// Compact when context usage exceeds the configured fraction (default 90%)
	// of the model's context window.
	return contextTokens > contextWindow * (settings.thresholdRatio ?? 0.9);
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;
/** Images have no text to scan; keep the legacy chars/4 estimate as tokens. */
const ESTIMATED_IMAGE_TOKENS = ESTIMATED_IMAGE_CHARS / 4;

function estimateTextAndImageContentTokens(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return estimateTextTokens(content);
	}

	let tokens = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			tokens += estimateTextTokens(block.text);
		} else if (block.type === "image") {
			tokens += ESTIMATED_IMAGE_TOKENS;
		}
	}
	return tokens;
}

/**
 * Estimate token count for a message.
 * Uses a CJK-aware heuristic (CJK codepoints ~1 token each, other text
 * ~4 chars per token) via {@link estimateTextTokens}.
 */
export function estimateTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user": {
			return estimateTextAndImageContentTokens(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			let tokens = 0;
			for (const block of assistant.content) {
				if (block.type === "text") {
					tokens += estimateTextTokens(block.text);
				} else if (block.type === "thinking") {
					tokens += estimateTextTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens += estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.arguments));
				}
			}
			return tokens;
		}
		case "custom":
		case "toolResult": {
			return estimateTextAndImageContentTokens(message.content);
		}
		case "bashExecution": {
			return estimateTextTokens(message.command) + estimateTextTokens(message.output);
		}
		case "branchSummary":
		case "compactionSummary": {
			return estimateTextTokens(message.summary);
		}
	}

	return 0;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
}

/**
 * Find the cut point in session entries that keeps the most recent
 * `keepRecentRounds` rounds. A round is bounded by user-like messages — a
 * user message opens a new round, and a bash execution block, custom
 * message, branch summary, or compaction summary also starts one. The cut
 * always lands on a round boundary; rounds are never split.
 *
 * ponytail: if the kept rounds alone exceed the model window, compaction
 * cannot shrink them (rounds are never split) — in practice `prune` stubs
 * bulky tool outputs before compaction fires, so this edge needs giant
 * non-prunable content. Add a token-ceiling fallback if it ever bites.
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentRounds: number,
): CutPointResult {
	// Collect round-start indices, newest first.
	const roundStarts: number[] = [];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			roundStarts.push(i);
		}
	}

	if (roundStarts.length === 0) {
		return { firstKeptEntryIndex: startIndex };
	}

	// Keep the newest `keepRecentRounds` rounds: cut at the oldest kept
	// round's start. Fewer rounds than the budget keeps the whole range.
	const keep = Math.max(0, Math.min(keepRecentRounds, roundStarts.length));
	let cutIndex = keep === 0 ? endIndex : roundStarts[keep - 1]!;

	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}

	return { firstKeptEntryIndex: cutIndex };
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

The conversation is in chronological order — the newest messages are at the END. Review it from newest to oldest: the most recent steps (last tool calls, results, and user messages) are the current state of the work and must be reflected in Progress and Next Steps. Do not omit the last few steps just because they are at the end.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

The new messages are in chronological order — the newest are at the END. Review them from newest to oldest first: the final steps are the current state of the work and must appear in Progress and Next Steps even if they are the very last messages.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers, env, sessionId };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		)
	).text;
}

/**
 * Drop the oldest conversation round — a user message plus everything up to
 * the next user message. Returns the input unchanged when fewer than two
 * rounds exist (nothing can be dropped without losing the newest state).
 */
function dropOldestRound(messages: AgentMessage[]): AgentMessage[] {
	let userSeen = 0;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") {
			userSeen++;
			if (userSeen === 2) return messages.slice(i);
		}
	}
	return messages;
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	// Fraction of reserveTokens budgeted for the summary output.
	const maxTokens = Math.min(
		Math.floor(OUTPUT_TOKEN_RESERVE_RATIO * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	const fixedOverheadTokens =
		estimateTextTokens(SUMMARIZATION_SYSTEM_PROMPT) +
		estimateTextTokens(basePrompt) +
		(previousSummary ? estimateTextTokens(previousSummary) : 0);

	// Context-space fit: when the request exceeds the model's context window,
	// drop the oldest conversation rounds one at a time — on iterative
	// compactions the previous summary continues to carry that earlier state
	// forward — until the request fits, and retry the same way when the
	// provider still rejects with a context-overflow error (the token
	// estimates are char-based and can undercount, e.g. dense CJK text).
	let attemptMessages = currentMessages;
	let droppedRounds = 0;
	for (let requests = 0; requests < MAX_SUMMARIZATION_REQUESTS; requests++) {
		// Serialize conversation to text so model doesn't try to continue it
		// (convertToLlm handles custom types like bashExecution, custom, etc.).
		const conversationText = serializeConversation(convertToLlm(attemptMessages));
		const conversationBudgetTokens =
			model.contextWindow - SUMMARIZATION_SAFETY_TOKENS - maxTokens - fixedOverheadTokens;
		if (
			model.contextWindow > 0 &&
			conversationBudgetTokens > 0 &&
			estimateTextTokens(conversationText) > conversationBudgetTokens
		) {
			// Over budget: drop the oldest round and re-serialize before
			// spending an API call that would be rejected.
			const reduced = dropOldestRound(attemptMessages);
			if (reduced.length < attemptMessages.length) {
				attemptMessages = reduced;
				droppedRounds++;
				continue;
			}
			// Nothing left to shed — the provider would reject the request
			// anyway, so fail without spending the API call.
			throw new Error(
				"Conversation still exceeds the model's context window after omitting tool-call details and all droppable rounds.",
			);
		}

		// Build the prompt with conversation wrapped in tags
		const notes: string[] = [];
		if (droppedRounds > 0) {
			notes.push(
				`[The oldest ${droppedRounds} conversation round${droppedRounds === 1 ? "" : "s"} were omitted to fit the model's context window.]`,
			);
		}
		let promptText = `${notes.length > 0 ? `${notes.join("\n")}\n\n` : ""}<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) {
			promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		}
		promptText += basePrompt;

		const summarizationMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		const completionOptions = createSummarizationOptions(
			model,
			maxTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			sessionId,
		);

		const response = await completeSummarization(
			model,
			{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
			completionOptions,
			streamFn,
			retry,
			callbacks,
		);

		if (response.stopReason !== "error") {
			if (response.content.some((block) => block.type === "toolCall")) {
				throw new Error("Summarization attempted to call a tool");
			}
			return { text: contentText(response.content), usage: response.usage };
		}

		const errorMessage = response.errorMessage || "Unknown error";
		if (isContextOverflow(response, model.contextWindow)) {
			const reduced = dropOldestRound(attemptMessages);
			if (reduced.length < attemptMessages.length) {
				attemptMessages = reduced;
				droppedRounds++;
				continue;
			}
		}
		throw new Error(`Summarization failed: ${errorMessage}`);
	}
	throw new Error("Summarization failed: request still exceeds the context window after dropping oldest rounds");
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** Action ledger from previous compaction, for cumulative tracking */
	previousLedger?: ActionLedger;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let previousLedger: ActionLedger | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			previousLedger = (prevCompaction.details as CompactionDetails).ledger;
		}
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	// Token accounting note: the two token quantities used here are deliberately
	// different measures, each correct for its own scenario (not a bug):
	//  - The compaction trigger (shouldCompact) uses request-scope usage after pruning.
	//  - tokensBefore records the full session-scope estimate of the pre-compaction context.

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentRounds);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < cutPoint.firstKeptEntryIndex; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	if (messagesToSummarize.length === 0) {
		return undefined;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	return {
		firstKeptEntryId,
		messagesToSummarize,
		tokensBefore,
		previousSummary,
		previousLedger,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param sessionId - Optional routing session ID forwarded without enabling prompt caching
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<CompactionResult> {
	const { firstKeptEntryId, messagesToSummarize, tokensBefore, previousSummary, previousLedger, fileOps, settings } =
		preparation;

	const result = await generateSummaryWithUsage(
		messagesToSummarize,
		model,
		settings.reserveTokens,
		apiKey,
		headers,
		signal,
		customInstructions,
		previousSummary,
		thinkingLevel,
		streamFn,
		env,
		retry,
		callbacks,
		sessionId,
	);
	let summary = result.text;
	const summaryUsage: Usage = result.usage;

	// The file lists (L1 contacts / L2 external changes) live in the
	// FileContextTracker and are checkpointed separately — they are not
	// part of the narrative summary. They are still stored in the entry
	// details for cumulative file-op tracking across compactions.
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);

	// Cumulative deterministic action ledger (no LLM): extracted from the
	// summarized range, merged over the previous compaction's ledger, rendered
	// into the summary, and persisted so the next compaction continues it.
	const ledger = extractLedgerActions(messagesToSummarize, previousLedger);
	const ledgerSection = renderLedger(ledger);
	if (ledgerSection) {
		summary += `\n\n## Action Ledger\n\n_Deterministic record of world-changing actions (cumulative across compactions)._\n${ledgerSection}`;
	}

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles, ledger } as CompactionDetails,
	};
}
