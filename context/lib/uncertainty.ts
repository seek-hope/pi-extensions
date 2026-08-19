/**
 * Incremental uncertainty review — model self-flagged uncertain claims,
 * collected during the conversation and decided by the user at run
 * boundaries instead of piling up until post-compaction review.
 *
 * Detection: the system prompt instructs the model to flag unverifiable
 * statements inline with a marker line:
 *
 *   [uncertain:inference] the API probably retries on 429
 *   [uncertain:state:src/config.ts] this file exports DEFAULT_GATE
 *   [uncertain:question] did the user want backward compatibility?
 *
 * Flags are parsed from assistant messages on message_end, queued, and
 * presented at agent_settled (run fully idle). User decisions are
 * persisted as session custom entries and injected into the compaction
 * verify pass so reviewed claims graduate out of the UNVERIFIED section.
 */

import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const UNCERTAINTY_SESSION_ENTRY_TYPE = "uncertainty";
/** Prune persisted snapshots after this many appends (keep only the newest). */
const PERSIST_PRUNE_THRESHOLD = 10;

export type UncertaintyType = "inference" | "question" | "state";

export interface UncertainFlag {
	/** Stable id: hash of type + normalized claim text. */
	id: string;
	type: UncertaintyType;
	claim: string;
	/** Optional file-path subject from the marker; enables stale detection. */
	subject?: string;
	/** Session entry id of the assistant message the flag was parsed from. */
	messageId: string;
	/** Set when re-queued because a prior decision's basis changed. */
	staleNote?: string;
}

export interface UncertaintyDecision {
	flagId: string;
	type: UncertaintyType;
	claim: string;
	subject?: string;
	decision: "verified" | "dismissed" | "corrected";
	/** User-supplied corrected fact (decision === "corrected"). */
	correction?: string;
	/** Who ruled: the user in the review UI, or the model in auto-review. */
	decidedBy?: "user" | "model";
	decidedAt: string; // ISO timestamp
}

/**
 * Marker line grammar:
 *   [uncertain] claim
 *   [uncertain:inference|question|state] claim
 *   [uncertain:inference|question|state:path/subject] claim
 * A bare [uncertain] defaults to type "inference".
 */
const MARKER_RE = /^\[uncertain(?::(inference|question|state))?(?::([^\]\n]+))?\][ \t]+(.+?)[ \t]*$/gim;

const VALID_TYPES = new Set<UncertaintyType>(["inference", "question", "state"]);

/** Normalize claim text for dedup: case-insensitive, whitespace-collapsed. */
export function normalizeClaim(claim: string): string {
	return claim.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable flag id from type + normalized claim (dedup key). */
export function flagId(type: UncertaintyType, claim: string): string {
	const hash = createHash("sha1")
		.update(`${type}:${normalizeClaim(claim)}`)
		.digest("hex");
	return `u${hash.slice(0, 10)}`;
}

/** Parse uncertainty markers from assistant message text. */
export function parseUncertainFlags(text: string, messageId: string): UncertainFlag[] {
	const flags: UncertainFlag[] = [];
	MARKER_RE.lastIndex = 0;
	let match = MARKER_RE.exec(text);
	while (match !== null) {
		const type = (match[1] as UncertaintyType | undefined) ?? "inference";
		if (!VALID_TYPES.has(type)) {
			match = MARKER_RE.exec(text);
			continue;
		}
		const subject = match[2]?.trim() || undefined;
		const claim = match[3]?.trim();
		if (claim) {
			flags.push({ id: flagId(type, claim), type, claim, subject, messageId });
		}
		match = MARKER_RE.exec(text);
	}
	return flags;
}

/**
 * System-prompt block teaching the model the marker protocol.
 * Appended when incremental uncertainty review is enabled.
 */
export const UNCERTAINTY_PROTOCOL_PROMPT = `
## Uncertainty flagging

When you state something you cannot directly verify from tool output — an inference, an assumption, a claim about external state, or an unresolved question — flag it inline on its own line so the user can review it:

[uncertain:inference] <unverified inference or assumption>
[uncertain:state:<file-path>] <claim about that file's current content/behavior>
[uncertain:question] <open question you are proceeding without an answer to>

Rules:
- Flag at the moment you make the claim, not later.
- One claim per marker line; keep the claim text short and self-contained.
- Use the optional :<file-path> subject when the claim is about a specific file.
- Do not flag things you directly observed in tool output — only unverified claims.
- Marker lines are visible to the user; keep working normally after flagging.`.trim();

interface UncertaintySnapshot {
	pending: UncertainFlag[];
	decisions: UncertaintyDecision[];
}

/**
 * Pending flags + append-only decision log for one session.
 * Persisted as snapshots in session custom entries (latest on branch wins).
 */
export class UncertaintyStore {
	private pendingFlags: UncertainFlag[] = [];
	private decisionLog: UncertaintyDecision[] = [];
	/** Claim dedup keys currently tracked (pending or decided). */
	private readonly seen = new Set<string>();
	private readonly sessionManager: SessionManager;

	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
		this.restoreFromBranch();
	}

	/** Dedup key: type + subject + claim. The same claim about a DIFFERENT
	 * subject (e.g. the same assertion on another file) is a new flag, while a
	 * verbatim re-flag of the same claim stays deduped. */
	private static keyOf(type: string, subject: string | undefined, claim: string): string {
		return `${type}:${subject ?? ""}:${normalizeClaim(claim)}`;
	}

	/** Scan assistant text for new markers. Returns the number of NEW flags queued. */
	scanAssistantText(text: string, messageId: string): number {
		let added = 0;
		for (const flag of parseUncertainFlags(text, messageId)) {
			const key = UncertaintyStore.keyOf(flag.type, flag.subject, flag.claim);
			if (this.seen.has(key)) continue;
			this.seen.add(key);
			this.pendingFlags.push(flag);
			added++;
		}
		if (added > 0) this.persist();
		return added;
	}

	/** Pending (undecided) flags in arrival order. */
	pending(): UncertainFlag[] {
		return [...this.pendingFlags];
	}

	/** Latest decision per flagId (append-only log, later supersedes earlier). */
	decisions(): UncertaintyDecision[] {
		const latest = new Map<string, UncertaintyDecision>();
		for (const d of this.decisionLog) latest.set(d.flagId, d);
		return [...latest.values()];
	}

	latestDecision(flagIdValue: string): UncertaintyDecision | undefined {
		for (let i = this.decisionLog.length - 1; i >= 0; i--) {
			if (this.decisionLog[i].flagId === flagIdValue) return this.decisionLog[i];
		}
		return undefined;
	}

	/** Record a decision for a pending flag. Returns false when unknown.
	 * A dismissed flag is physically removed — dismissal means the claim
	 * leaves the context entirely, not that a "dismissed" ruling is kept
	 * around. */
	decide(
		flagIdValue: string,
		decision: UncertaintyDecision["decision"],
		correction?: string,
		decidedBy: "user" | "model" = "user",
	): boolean {
		const idx = this.pendingFlags.findIndex((f) => f.id === flagIdValue);
		if (idx === -1) return false;
		const flag = this.pendingFlags[idx];
		this.pendingFlags.splice(idx, 1);
		if (decision === "dismissed") {
			this.seen.delete(UncertaintyStore.keyOf(flag.type, flag.subject, flag.claim));
			this.persist();
			return true;
		}
		this.appendDecision(flag, decision, correction, decidedBy);
		this.persist();
		return true;
	}

	/**
	 * Flip an already-decided flag (from /review or auto-review): append a
	 * superseding decision. The flag must not be pending.
	 * Dismissing erases the flag (and its decision history) entirely.
	 */
	overrideDecision(
		flagIdValue: string,
		decision: UncertaintyDecision["decision"],
		correction?: string,
		decidedBy: "user" | "model" = "user",
	): boolean {
		const prev = this.latestDecision(flagIdValue);
		if (!prev) return false;
		if (decision === "dismissed") {
			this.decisionLog = this.decisionLog.filter((d) => d.flagId !== flagIdValue);
			this.seen.delete(UncertaintyStore.keyOf(prev.type, prev.subject, prev.claim));
			this.persist();
			return true;
		}
		this.appendDecision(
			{
				id: prev.flagId,
				type: prev.type,
				claim: prev.claim,
				subject: prev.subject,
				messageId: "",
			},
			decision,
			correction,
			decidedBy,
		);
		this.persist();
		return true;
	}

	/**
	 * Physically remove a flag (pending or decided) and its decision
	 * history. Used by the content-dedup pass: a flag superseded by a
	 * duplicate/contradicting newer one leaves the context entirely.
	 */
	remove(flagIdValue: string): boolean {
		const pendingIdx = this.pendingFlags.findIndex((f) => f.id === flagIdValue);
		if (pendingIdx !== -1) {
			const f = this.pendingFlags[pendingIdx];
			this.pendingFlags.splice(pendingIdx, 1);
			this.seen.delete(UncertaintyStore.keyOf(f.type, f.subject, f.claim));
			this.persist();
			return true;
		}
		const prev = this.latestDecision(flagIdValue);
		if (prev) {
			this.decisionLog = this.decisionLog.filter((d) => d.flagId !== flagIdValue);
			this.seen.delete(UncertaintyStore.keyOf(prev.type, prev.subject, prev.claim));
			this.persist();
			return true;
		}
		return false;
	}

	/** Rewrite a flag's claim text (content-dedup merge). Keeps id and ruling. */
	updateClaim(flagIdValue: string, newText: string): boolean {
		const claim = newText.trim();
		if (!claim) return false;
		const pending = this.pendingFlags.find((f) => f.id === flagIdValue);
		if (pending) {
			this.seen.delete(UncertaintyStore.keyOf(pending.type, pending.subject, pending.claim));
			pending.claim = claim;
			this.seen.add(UncertaintyStore.keyOf(pending.type, pending.subject, claim));
			this.persist();
			return true;
		}
		for (let i = this.decisionLog.length - 1; i >= 0; i--) {
			const d = this.decisionLog[i]!;
			if (d.flagId !== flagIdValue) continue;
			this.seen.delete(UncertaintyStore.keyOf(d.type, d.subject, d.claim));
			d.claim = claim;
			this.seen.add(UncertaintyStore.keyOf(d.type, d.subject, claim));
			this.persist();
			return true;
		}
		return false;
	}

	/**
	 * Send a decided flag back to the pending queue for re-review.
	 * The prior decision stays in the log until superseded by the new one.
	 */
	requeue(flagIdValue: string, staleNote?: string): boolean {
		if (this.pendingFlags.some((f) => f.id === flagIdValue)) return false;
		const prev = this.latestDecision(flagIdValue);
		if (!prev) return false;
		this.pendingFlags.push({
			id: prev.flagId,
			type: prev.type,
			claim: prev.claim,
			subject: prev.subject,
			messageId: "",
			staleNote,
		});
		this.persist();
		return true;
	}

	/**
	 * Stale detection: a file was modified after decisions referenced it as
	 * subject. Those decisions are re-queued with a note; until re-reviewed
	 * they must not be treated as verified at compaction.
	 * Returns the number of decisions re-queued.
	 */
	markPathModified(path: string): number {
		const normalized = path.replace(/\\/g, "/");
		let requeued = 0;
		for (const d of this.decisions()) {
			if (!d.subject) continue;
			const subject = d.subject.replace(/\\/g, "/");
			if (subject !== normalized && !normalized.endsWith(`/${subject}`) && !subject.endsWith(`/${normalized}`)) {
				continue;
			}
			if (this.requeue(d.flagId, `basis changed: ${path} was modified after this was ${d.decision}`)) {
				requeued++;
			}
		}
		return requeued;
	}

	/** Render decisions for the compaction verify pass (pass C). */
	formatForVerifyPass(): string | undefined {
		const decisions = this.decisions();
		const pending = this.pendingFlags;
		if (decisions.length === 0 && pending.length === 0) return undefined;
		// A requeued flag lives in both sets until re-decided: the pending
		// entry wins, so the verify pass never sees a stale ruling as fact.
		const pendingIds = new Set(pending.map((f) => f.id));
		const lines: string[] = [
			"During the conversation, uncertainty flags raised by the assistant were reviewed. Apply the rulings:",
		];
		for (const d of decisions) {
			if (pendingIds.has(d.flagId)) continue;
			const by = d.decidedBy === "model" ? "auto-reviewed against the latest context" : "reviewed by the user";
			if (d.decision === "verified") {
				lines.push(`- [VERIFIED, ${by}] "${d.claim}" — treat as confirmed fact; do NOT list as unverified.`);
			} else if (d.decision === "corrected") {
				lines.push(
					`- [CORRECTED, ${by}] "${d.claim}" → correction: "${d.correction}" — treat the correction as fact; do NOT list as unverified.`,
				);
			} else {
				lines.push(`- [DISMISSED, ${by}] "${d.claim}" — ruled not load-bearing; omit from modelInferences.`);
			}
		}
		if (pending.length > 0) {
			lines.push("", "Still undecided (keep these as unverified if still relevant):");
			for (const f of pending) {
				lines.push(`- [PENDING] "${f.claim}"${f.staleNote ? ` (${f.staleNote})` : ""}`);
			}
		}
		return lines.join("\n");
	}

	/** Confirmed facts for the deterministic checkpoint section. */
	verifiedSectionLines(): string[] {
		const lines: string[] = [];
		const pendingIds = new Set(this.pendingFlags.map((f) => f.id));
		for (const d of this.decisions()) {
			if (pendingIds.has(d.flagId)) continue;
			if (d.decision === "verified") {
				lines.push(`- ${d.claim}`);
			} else if (d.decision === "corrected") {
				lines.push(`- ${d.claim} → corrected to: ${d.correction}`);
			}
		}
		return lines;
	}

	private appendDecision(
		flag: UncertainFlag,
		decision: UncertaintyDecision["decision"],
		correction?: string,
		decidedBy: "user" | "model" = "user",
	): void {
		this.decisionLog.push({
			flagId: flag.id,
			type: flag.type,
			claim: flag.claim,
			subject: flag.subject,
			decision,
			correction,
			decidedBy,
			decidedAt: new Date().toISOString(),
		});
	}

	private persist(): void {
		const snapshot: UncertaintySnapshot = {
			pending: this.pendingFlags,
			decisions: this.decisionLog,
		};
		this.sessionManager.appendCustomEntry(UNCERTAINTY_SESSION_ENTRY_TYPE, snapshot);
		this._persistedSincePrune++;
		// Snapshots are full-state; only the newest matters. Keep the session
		// file from accumulating one copy per flag/decision forever.
		if (this._persistedSincePrune >= PERSIST_PRUNE_THRESHOLD) {
			this._persistedSincePrune = 0;
			this.sessionManager.pruneCustomEntries(UNCERTAINTY_SESSION_ENTRY_TYPE, 1);
		}
	}

	private _persistedSincePrune = 0;

	/** Restore from the latest uncertainty snapshot on the current branch. */
	private restoreFromBranch(): void {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== UNCERTAINTY_SESSION_ENTRY_TYPE) continue;
			const data = entry.data as UncertaintySnapshot | undefined;
			// A corrupt snapshot must not hide an earlier valid one — keep
			// walking back the branch instead of giving up empty-handed.
			if (!data || !Array.isArray(data.pending) || !Array.isArray(data.decisions)) continue;
			this.pendingFlags = data.pending.filter((f) => f && typeof f.id === "string" && typeof f.claim === "string");
			this.decisionLog = data.decisions.filter((d) => d && typeof d.flagId === "string");
			this.seen.clear();
			for (const f of this.pendingFlags) this.seen.add(UncertaintyStore.keyOf(f.type, f.subject, f.claim));
			for (const d of this.decisionLog) this.seen.add(UncertaintyStore.keyOf(d.type, d.subject, d.claim));
			return;
		}
	}
}
