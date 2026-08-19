/**
 * Content-level dedup pass (layer 1 of the compaction flag review).
 *
 * Before the context review (layer 2) judges flags against the latest
 * conversation, one batched model call removes content-level redundancy:
 * duplicated restatements and contradicting claims, keeping the NEWEST
 * entry of each group (entries are listed newest first). The model may
 * also rewrite the kept entry to merge information from the deleted ones.
 *
 * Dismissal here is physical: removed flags leave the store entirely
 * (no decision-log entry) so the compaction context stays clean. The
 * layer-2 context review keeps deciding pending flags afterwards.
 *
 * Never throws — failures leave the store untouched.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, RetryPolicy } from "@earendil-works/pi-ai";
import type { UserOverrideProposal } from "./auto-review.ts";
import { completeSummarization } from "@earendil-works/pi-coding-agent";
import { extractFirstBalancedJson } from "./utils.ts";
import type { UncertaintyStore } from "./uncertainty.ts";

/** Max entries per batch (newest first; older entries stay untouched). */
const MAX_ENTRIES_PER_BATCH = 200;

export interface DedupEntry {
	id: string;
	type: "inference" | "question" | "state";
	claim: string;
	subject?: string;
	/** True when this entry is an already-decided flag (verified/corrected). */
	decided: boolean;
	/** Who ruled on a decided entry — user rulings are never deleted silently. */
	decidedBy?: "user" | "model";
}

export interface DedupOptions {
	model: Model<any>;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	/** Injectable single-turn completion (used by tests); defaults to completeSummarization. */
	complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
	/**
	 * Confirmation hook for deleting a USER-ruled entry (verified/corrected by
	 * the user). Model-ruled and pending entries are deleted without asking.
	 * When absent, user-ruled entries are kept.
	 */
	onUserOverrideProposal?: (proposal: UserOverrideProposal) => Promise<boolean>;
}

export interface DedupResult {
	removed: number;
	rewritten: number;
}

/** Collect pending + decided flags, newest first (pending tail = newest arrival). */
export function collectDedupEntries(store: UncertaintyStore): DedupEntry[] {
	const entries: DedupEntry[] = [];
	const pending = store.pending();
	for (let i = pending.length - 1; i >= 0; i--) {
		const f = pending[i]!;
		entries.push({ id: f.id, type: f.type, claim: f.claim, subject: f.subject, decided: false });
	}
	const decisions = store.decisions();
	// Decisions are appended chronologically; newest last. Dismissed flags
	// are never stored, so only verified/corrected appear here.
	for (let i = decisions.length - 1; i >= 0; i--) {
		const d = decisions[i]!;
		entries.push({
			id: d.flagId,
			type: d.type,
			claim: d.claim,
			subject: d.subject,
			decided: true,
			decidedBy: d.decidedBy,
		});
	}
	return entries.slice(0, MAX_ENTRIES_PER_BATCH);
}

/** Never throws — failures leave the store untouched. */
export async function runContentDedup(store: UncertaintyStore, options: DedupOptions): Promise<DedupResult> {
	const entries = collectDedupEntries(store);
	if (entries.length === 0) return { removed: 0, rewritten: 0 };
	try {
		const prompt = buildDedupPrompt(entries);
		let text: string;
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
					maxTokens: 100 + entries.length * 60,
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
		const rulings = parseDedupRulings(text);
		if (!rulings || rulings.length === 0) return { removed: 0, rewritten: 0 };
		let removed = 0;
		let rewritten = 0;
		for (let i = 0; i < entries.length && i < rulings.length; i++) {
			const entry = entries[i]!;
			const ruling = rulings[i]!;
			// Strict alignment: a mismatched id invalidates that ruling only.
			if (ruling.id !== entry.id) continue;
			if (ruling.action === "delete") {
				// A user-ruled fact is never deleted silently — ask first.
				if (entry.decided && entry.decidedBy === "user") {
					const accepted = options.onUserOverrideProposal
						? await options.onUserOverrideProposal({
								flagId: entry.id,
								claim: entry.claim,
								decision: "dismissed",
							})
						: false;
					if (!accepted) continue;
				}
				if (store.remove(entry.id)) removed++;
			} else if (ruling.action === "rewrite" && ruling.text) {
				// Same guard as delete: a user-ruled fact is never rewritten silently.
				if (entry.decided && entry.decidedBy === "user") {
					const accepted = options.onUserOverrideProposal
						? await options.onUserOverrideProposal({
								flagId: entry.id,
								claim: entry.claim,
								decision: "corrected",
								correction: ruling.text,
							})
						: false;
					if (!accepted) continue;
				}
				if (store.updateClaim(entry.id, ruling.text)) rewritten++;
			}
		}
		return { removed, rewritten };
	} catch {
		return { removed: 0, rewritten: 0 };
	}
}

export function buildDedupPrompt(entries: DedupEntry[]): string {
	const lines = entries.map(
		(e, i) =>
			`${i + 1}. [${e.type}${e.decided ? ", decided" : ""}] ${e.claim}${e.subject ? ` (subject: ${e.subject})` : ""} — id: ${e.id}`,
	);
	return [
		"You are cleaning up a list of uncertainty flags (claims the assistant self-flagged as unverified).",
		"Remove only CONTENT-level redundancy and contradictions. Do NOT judge whether a claim is",
		"true or still relevant — a later pass reviews the survivors against the conversation.",
		"",
		"Rules:",
		"- Entries are listed NEWEST first. When entries duplicate or contradict each other,",
		"  keep the NEWEST one and delete the older ones.",
		"- Duplicates: the same claim restated in different words, or a claim subsumed by a",
		"  broader newer claim.",
		'- Contradictions: one claim contradicts another (e.g. "X is A" vs "X is not A").',
		"- You may rewrite the kept entry's text to merge information from the deleted entries",
		'  (action "rewrite" with text).',
		"- Never delete an entry just because it looks unlikely, unsupported, or resolved.",
		"- Keep every entry that is unique in content.",
		"",
		"Entries:",
		...lines,
		"",
		"Reply with exactly one JSON array, one object per listed entry in order:",
		'[{"id":"<entry id>","action":"keep"|"delete"|"rewrite","text":"<merged text, only for rewrite>"}, ...]',
	].join("\n");
}

interface DedupRuling {
	id: string;
	action: "keep" | "delete" | "rewrite";
	text?: string;
}

/** Any malformed element invalidates the whole batch (atomic). */
export function parseDedupRulings(text: string): DedupRuling[] | undefined {
	const match = extractFirstBalancedJson(text, "[");
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		const rulings: DedupRuling[] = [];
		for (const raw of parsed) {
			const obj = raw as { id?: unknown; action?: unknown; text?: unknown };
			if (typeof obj.id !== "string") return undefined;
			if (obj.action !== "keep" && obj.action !== "delete" && obj.action !== "rewrite") return undefined;
			if (obj.action === "rewrite") {
				const text = typeof obj.text === "string" ? obj.text.trim() : "";
				if (!text) return undefined;
				rulings.push({ id: obj.id, action: obj.action, text });
			} else {
				rulings.push({ id: obj.id, action: obj.action });
			}
		}
		return rulings;
	} catch {
		return undefined;
	}
}

function contentTextOf(message: AssistantMessage): string {
	return (message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
}
