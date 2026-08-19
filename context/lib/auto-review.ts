/**
 * Automatic uncertainty review — the model re-examines pending flags in
 * newest-to-oldest order against the current conversation, so context
 * always aligns with the user's latest intent.
 *
 * Design:
 * - Order: newest flag first. The latest conversation (and user intent) is
 *   the most reliable basis; older flags are judged against it.
 * - No backtracking: each flag is decided exactly once per pass.
 * - User-decided flags are skipped: the auto-review never overrides a user
 *   ruling (users can always flip their own rulings via /review).
 * - Failures degrade silently: a flag that cannot be decided stays pending.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { RetryPolicy } from "@earendil-works/pi-ai/compat";
import { completeSummarization } from "@earendil-works/pi-coding-agent";
import { extractFirstBalancedJson } from "./utils.ts";
import type { UncertaintyStore } from "./uncertainty.ts";

export interface AutoReviewCandidate {
	id: string;
	type: "inference" | "question" | "state";
	claim: string;
	subject?: string;
}

export interface UserOverrideProposal {
	flagId: string;
	claim: string;
	decision: "verified" | "dismissed" | "corrected";
	correction?: string;
}

export interface AutoReviewOptions {
	model: Model<any>;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	/** Recent conversation text used as the review basis (newest last). */
	contextText: string;
	/** Per-flag max tokens. */
	maxTokens?: number;
	/** Injectable single-turn completion (used by tests); defaults to completeSummarization. */
	complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
	/**
	 * Candidates to review, newest first: pending flags plus already-decided
	 * ones the latest context may overturn. User rulings are never changed
	 * silently — the proposal hook decides (typically a confirmation popup).
	 */
	candidates: AutoReviewCandidate[];
	/** Called when the model wants to overturn a user ruling. Resolve(true) to apply. */
	onUserOverrideProposal?: (proposal: UserOverrideProposal) => Promise<boolean>;
}

export interface AutoReviewResult {
	/** Flags decided in this pass. */
	decided: number;
	/** Already-decided flags the pass overturned (model rulings). */
	overridden: number;
	/** User rulings the model proposed to overturn (accepted or not). */
	proposed: number;
	/** Flags the model could not confirm and were dropped (dismissed). */
	dismissed: number;
	/** Flags whose review call failed — left pending for the next pass. */
	failed: number;
	/** Flags skipped because they were settled while the pass ran. */
	skipped: number;
}
const MAX_CONTEXT_CHARS = 6000;

function flagPrompt(flag: AutoReviewCandidate, contextText: string): string {
	const typeLabel =
		flag.type === "inference"
			? "inference (assistant's deduction)"
			: flag.type === "question"
				? "open question"
				: "observed state";
	const subject = flag.subject ? `\n- subject file: ${flag.subject}` : "";
	return [
		"You are reviewing a flagged uncertainty entry against the latest conversation. ",
		"The user's most recent intent takes precedence: an entry that the newer context",
		"contradicts, supersedes, or renders irrelevant must not survive in memory.",
		"",
		"Conversation since this flag was raised (newest at the end):",
		`<context>\n${contextText}\n</context>`,
		"",
		"Flag:",
		`- kind: ${typeLabel}`,
		`- claim: "${flag.claim}"${subject}`,
		"",
		"Decide the flag's fate in memory:",
		'- "verified": still consistent with the latest context — keep it',
		'- "dismissed": superseded, contradicted, or no longer relevant — drop it',
		'- "corrected": mostly right but needs a fix — give the corrected statement',
		"",
		"Reply with exactly one JSON object and nothing else:",
		'{"decision":"verified"|"dismissed"|"corrected","correction":"<text, only when corrected>"}',
	].join("\n");
}

function parseDecision(
	text: string,
): { decision: "verified" | "dismissed" | "corrected"; correction?: string } | undefined {
	const objectText = extractFirstBalancedJson(text, "{");
	if (!objectText) return undefined;
	try {
		const parsed = JSON.parse(objectText) as {
			decision?: unknown;
			correction?: unknown;
		};
		const decision = parsed.decision;
		if (decision !== "verified" && decision !== "dismissed" && decision !== "corrected") {
			return undefined;
		}
		if (decision === "corrected") {
			const correction = typeof parsed.correction === "string" ? parsed.correction.trim() : "";
			if (!correction) return undefined;
			return { decision, correction };
		}
		return { decision };
	} catch {
		return undefined;
	}
}

/** Parse a JSON array of flag ids out of a conflict-detection response. */
export function parseConflictIds(text: string): string[] {
	const match = extractFirstBalancedJson(text, "[");
	if (!match) return [];
	try {
		const parsed = JSON.parse(match) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string");
	} catch {
		return [];
	}
}

/**
 * Review candidates newest-first (caller orders them). Each flag gets its
 * own model call; malformed responses drop the flag — an entry the model
 * cannot confirm is discarded rather than pushed to the user: the details
 * a user actually cares about are easy to reason about, while the
 * hard-to-judge entries are the low-value trivia.
 *
 * Ruling application by current state:
 * - pending flag        → decided directly (decidedBy: "model")
 * - model ruling        → overturned directly if the context changed it
 * - user ruling         → never changed silently: the model's new ruling is
 *                         passed to onUserOverrideProposal (a confirmation
 *                         popup); resolve(true) applies it as a user ruling
 *
 * Never throws.
 */
export async function runAutoReview(store: UncertaintyStore, options: AutoReviewOptions): Promise<AutoReviewResult> {
	const contextText = options.contextText.slice(0, MAX_CONTEXT_CHARS);
	const result: AutoReviewResult = { decided: 0, overridden: 0, proposed: 0, dismissed: 0, failed: 0, skipped: 0 };

	// An entry the model could not confirm is dropped instead of staying
	// pending for the user — unjudgeable detail is exactly the trivia that
	// should not survive in memory.
	const drop = (flag: AutoReviewCandidate) => {
		try {
			if (store.decide(flag.id, "dismissed", undefined, "model")) {
				result.dismissed++;
			} else {
				result.skipped++;
			}
		} catch {
			result.skipped++;
		}
	};

	for (const flag of options.candidates) {
		if (options.signal?.aborted) break;
		try {
			let text: string;
			if (options.complete) {
				text = await options.complete(flagPrompt(flag, contextText), options.signal);
			} else {
				const messages: Message[] = [
					{
						role: "user",
						content: [{ type: "text" as const, text: flagPrompt(flag, contextText) }],
						timestamp: Date.now(),
					},
				];
				const message = await completeSummarization(
					options.model,
					{ messages },
					{
						maxTokens: options.maxTokens ?? 300,
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
			const ruling = parseDecision(text);
			if (!ruling) {
				drop(flag);
				continue;
			}

			// Pending flag: decide it directly.
			if (store.pending().some((f) => f.id === flag.id)) {
				if (store.decide(flag.id, ruling.decision, ruling.correction, "model")) {
					result.decided++;
				} else {
					result.skipped++;
				}
				continue;
			}

			// Already decided. Model rulings may be overturned directly;
			// user rulings require confirmation (never silent).
			const prior = store.latestDecision(flag.id);
			if (!prior) {
				result.skipped++;
				continue;
			}
			if (
				prior.decision === ruling.decision &&
				(prior.decision !== "corrected" || prior.correction === ruling.correction)
			) {
				result.skipped++;
				continue;
			}
			if (prior.decidedBy === "model") {
				if (store.overrideDecision(flag.id, ruling.decision, ruling.correction, "model")) {
					result.overridden++;
				} else {
					result.skipped++;
				}
			} else {
				result.proposed++;
				const accepted = options.onUserOverrideProposal
					? await options.onUserOverrideProposal({
							flagId: flag.id,
							claim: flag.claim,
							decision: ruling.decision,
							correction: ruling.correction,
						})
					: false;
				if (accepted && store.overrideDecision(flag.id, ruling.decision, ruling.correction, "user")) {
					result.decided++;
				}
			}
		} catch {
			// The review call failed — the model never saw this flag, so
			// "could not confirm" does not apply. Leave it pending for the
			// next pass instead of dropping it over a transient error.
			result.failed++;
		}
	}
	return result;
}

function contentTextOf(message: AssistantMessage): string {
	return (message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
}
