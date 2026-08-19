/**
 * Automatic review of the compaction summary's uncertain sections
 * (Model Inferences / Open Questions / External State).
 *
 * Those entries are produced by the compaction verify pass and live
 * outside the uncertainty store, so the per-flag auto-review never saw
 * them — every compaction surfaced them again as "unverified items" for
 * the user. With the auto setting on, one batched model call judges the
 * entries newest-first against the latest conversation: verified and
 * corrected entries receive an AUTO_REVIEWED_MARKER, and dismissed entries
 * are dropped from the store, so parseUncertainItems() stops reporting them.
 * Entries the call cannot settle are handled by failure kind: a failed
 * review call (timeout/network) keeps the entries for the next pass —
 * the model never saw them; a response the model gave but that cannot be
 * parsed drops the unconfirmed entries — details a user actually cares
 * about are easy to reason about, while the hard-to-judge ones are
 * precisely the low-value trivia that should not survive in memory.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, RetryPolicy } from "@earendil-works/pi-ai";
import { completeSummarization } from "@earendil-works/pi-coding-agent";
import { extractFirstBalancedJson } from "./utils.ts";
import { AUTO_REVIEWED_MARKER, parseUncertainItems } from "./review.ts";

/** How many entries one batch call may judge (newest first; the rest stay manual). */
const MAX_ITEMS_PER_BATCH = 25;
const MAX_CONTEXT_CHARS = 6000;

export interface SummaryReviewOptions {
	model: Model<any>;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	/** Recent conversation text used as the review basis (newest last). */
	contextText: string;
	/** Injectable single-turn completion (used by tests); defaults to completeSummarization. */
	complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
}

interface SummaryRuling {
	decision: "verified" | "dismissed" | "corrected";
	correction?: string;
}

/** Never throws — entries the call cannot settle are dropped. */
export async function autoReviewSummaryItems(summary: string, options: SummaryReviewOptions): Promise<string> {
	const items = parseUncertainItems(summary);
	if (items.length === 0) return summary;
	// Newest first: the summary lists sections in checkpoint order, so
	// later source lines are the most recent statements.
	const ordered = [...items].reverse().slice(0, MAX_ITEMS_PER_BATCH);

	let text: string;
	try {
		const prompt = buildSummaryReviewPrompt(ordered, options.contextText.slice(0, MAX_CONTEXT_CHARS));

		if (options.complete) {
			text = await options.complete(prompt, options.signal);
		} else {
			const messages: Message[] = [
				{
					role: "user",
					content: [{ type: "text" as const, text: prompt }],
					timestamp: Date.now(),
				},
			];
			const message = await completeSummarization(
				options.model,
				{ messages },
				{
					maxTokens: 120 + ordered.length * 90,
					apiKey: options.apiKey,
					headers: options.headers,
					env: options.env,
					signal: options.signal,
				},
				options.streamFn,
				options.retry,
			);
			text = contentTextOf(message);
		}
	} catch {
		// The review call failed (timeout/network) — the model never saw the
		// entries, so "could not confirm" does not apply. Keep them for the
		// next pass rather than dropping fresh context over a transient error.
		return summary;
	}

	const rulings = parseSummaryRulings(text);
	// The model responded but its rulings are unusable — entries it could
	// not confirm are dropped (unjudgeable detail should not survive).
	return applySummaryRulings(summary, ordered, rulings ?? []);
}

export function buildSummaryReviewPrompt(
	items: Array<{ type: "inference" | "question" | "state"; text: string }>,
	contextText: string,
): string {
	const lines = items.map((item, i) => {
		const kind =
			item.type === "inference" ? "model inference" : item.type === "question" ? "open question" : "observed state";
		return `${i + 1}. [${kind}] ${item.text}`;
	});
	return [
		"You are reviewing uncertainty entries from a context checkpoint against the latest conversation. ",
		"The user's most recent intent takes precedence: an entry the newer context",
		"contradicts, supersedes, or renders irrelevant must not survive in memory.",
		"",
		"Conversation (newest at the end):",
		`<context>\n${contextText}\n</context>`,
		"",
		"Entries (newest first):",
		...lines,
		"",
		"For each entry decide its fate in memory:",
		'- "verified": still consistent with the latest context — keep it',
		'- "dismissed": superseded, contradicted, or no longer relevant — drop it',
		'- "corrected": mostly right but needs a fix — give the corrected statement',
		"",
		"Reply with exactly one JSON array (one object per entry, in order) and nothing else:",
		'[{"decision":"verified"|"dismissed"|"corrected","correction":"<text, only when corrected>"}, ...]',
	].join("\n");
}

export function parseSummaryRulings(text: string): SummaryRuling[] | undefined {
	const match = extractFirstBalancedJson(text, "[");
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		const rulings: SummaryRuling[] = [];
		for (const raw of parsed) {
			const obj = raw as { decision?: unknown; correction?: unknown };
			if (obj.decision !== "verified" && obj.decision !== "dismissed" && obj.decision !== "corrected") {
				return undefined; // any malformed element invalidates the batch
			}
			if (obj.decision === "corrected") {
				const correction = typeof obj.correction === "string" ? obj.correction.trim() : "";
				if (!correction) return undefined;
				rulings.push({ decision: obj.decision, correction });
			} else {
				rulings.push({ decision: obj.decision });
			}
		}
		return rulings;
	} catch {
		return undefined;
	}
}

/**
 * Apply rulings to the summary by source line. Rulings align with the
 * ordered entries they were issued for (newest first). Dismissed entries
 * are removed from the summary entirely (the context stays clean);
 * verified/corrected entries get the auto-verified marker, so
 * parseUncertainItems() skips them.
 */
export function applySummaryRulings(
	summary: string,
	ordered: Array<{ sourceLine: number; type: "inference" | "question" | "state"; text: string }>,
	rulings: SummaryRuling[],
): string {
	const markerByLine = new Map<number, string>();
	const correctedByLine = new Map<number, string>();
	const removedByLine = new Set<number>();
	for (let i = 0; i < ordered.length; i++) {
		const item = ordered[i]!;
		const ruling = rulings[i];
		if (ruling?.decision === "dismissed") {
			removedByLine.add(item.sourceLine);
		} else if (ruling?.decision === "corrected") {
			correctedByLine.set(item.sourceLine, ruling.correction!);
			markerByLine.set(item.sourceLine, AUTO_REVIEWED_MARKER);
		} else if (ruling?.decision === "verified") {
			markerByLine.set(item.sourceLine, AUTO_REVIEWED_MARKER);
		} else {
			// Missing/unusable ruling — the model could not confirm the entry.
			removedByLine.add(item.sourceLine);
		}
	}
	if (markerByLine.size === 0 && removedByLine.size === 0) return summary;

	const lines = summary.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (removedByLine.has(i)) continue; // dismissed — dropped entirely
		const correction = correctedByLine.get(i);
		out.push(correction !== undefined ? `- ${correction}` : lines[i]!);
		const marker = markerByLine.get(i);
		if (marker) out.push(`  ${marker}`);
	}
	return out.join("\n");
}

function contentTextOf(message: AssistantMessage): string {
	return (message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
}
