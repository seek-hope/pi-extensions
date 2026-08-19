/**
 * Tests for incremental uncertainty review: marker parsing, decision
 * store semantics, stale re-queueing, and session persistence.
 */
import { describe, expect, it } from "vitest";
import {
	flagId,
	normalizeClaim,
	parseUncertainFlags,
	UNCERTAINTY_SESSION_ENTRY_TYPE,
	UncertaintyStore,
} from "../context/lib/uncertainty.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

describe("parseUncertainFlags", () => {
	it("parses all three types with and without subjects", () => {
		const text = [
			"Some normal prose first.",
			"[uncertain:inference] the API probably retries on 429",
			"[uncertain:state:src/config.ts] this file exports DEFAULT_GATE",
			"[uncertain:question] did the user want backward compat?",
		].join("\n");
		const flags = parseUncertainFlags(text, "m1");
		expect(flags).toHaveLength(3);
		expect(flags[0]).toMatchObject({ type: "inference", claim: "the API probably retries on 429" });
		expect(flags[1]).toMatchObject({
			type: "state",
			claim: "this file exports DEFAULT_GATE",
			subject: "src/config.ts",
		});
		expect(flags[2]).toMatchObject({ type: "question" });
		expect(flags.every((f) => f.messageId === "m1")).toBe(true);
	});

	it("defaults a bare [uncertain] marker to inference", () => {
		const flags = parseUncertainFlags("[uncertain] something unverified", "m1");
		expect(flags).toHaveLength(1);
		expect(flags[0].type).toBe("inference");
	});

	it("ignores prose and malformed markers", () => {
		expect(parseUncertainFlags("no markers here", "m1")).toHaveLength(0);
		expect(parseUncertainFlags("[uncertain:inference]", "m1")).toHaveLength(0); // no claim
		// Unknown single tag parses leniently as a subject-only marker (still
		// surfaces to the user instead of being silently dropped).
		const lenient = parseUncertainFlags("[uncertain:bogus] bad type", "m1");
		expect(lenient).toHaveLength(1);
		expect(lenient[0]).toMatchObject({ type: "inference", subject: "bogus" });
	});

	it("produces stable ids via type + normalized claim", () => {
		const a = parseUncertainFlags("[uncertain:inference] The API retries", "m1");
		const b = parseUncertainFlags("[uncertain:inference] the   API  retries", "m2");
		expect(a[0].id).toBe(b[0].id);
		expect(a[0].id).toBe(flagId("inference", "The API retries"));
	});

	it("normalizeClaim collapses whitespace and case", () => {
		expect(normalizeClaim("  Foo   Bar \n Baz ")).toBe("foo bar baz");
	});
});

describe("UncertaintyStore", () => {
	function makeStore() {
		return new UncertaintyStore(SessionManager.inMemory());
	}

	it("queues new flags and dedups repeated claims", () => {
		const store = makeStore();
		expect(store.scanAssistantText("[uncertain:inference] claim one", "m1")).toBe(1);
		expect(store.scanAssistantText("[uncertain:inference] claim one", "m2")).toBe(0);
		expect(store.scanAssistantText("[uncertain:question] claim two", "m3")).toBe(1);
		expect(store.pending()).toHaveLength(2);
	});

	it("decide() moves a flag from pending to the decision log", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] claim one", "m1");
		const flag = store.pending()[0];
		expect(store.decide(flag.id, "verified")).toBe(true);
		expect(store.pending()).toHaveLength(0);
		expect(store.decisions()).toHaveLength(1);
		expect(store.decisions()[0]).toMatchObject({ flagId: flag.id, decision: "verified", claim: "claim one" });
		expect(store.decide("unknown", "verified")).toBe(false);
	});

	it("corrected decisions carry the correction text", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] wrong assumption", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "corrected", "the actual fact");
		expect(store.decisions()[0]).toMatchObject({ decision: "corrected", correction: "the actual fact" });
	});

	it("markPathModified re-queues decisions whose subject changed", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:state:src/config.ts] exports DEFAULT_GATE", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified");
		expect(store.markPathModified("src/config.ts")).toBe(1);
		const requeued = store.pending();
		expect(requeued).toHaveLength(1);
		expect(requeued[0].id).toBe(flag.id);
		expect(requeued[0].staleNote).toContain("src/config.ts");
		// Unrelated paths don't touch it
		expect(store.markPathModified("src/other.ts")).toBe(0);
	});

	it("markPathModified ignores pending flags and subject-less decisions", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] no subject here", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified");
		expect(store.markPathModified("src/config.ts")).toBe(0);
		expect(store.pending()).toHaveLength(0);
	});

	it("overrideDecision supersedes an earlier ruling (latest wins)", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] claim one", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified");
		expect(store.overrideDecision(flag.id, "dismissed")).toBe(true);
		// Dismissal erases the flag entirely — no ruling is kept around.
		expect(store.decisions()).toHaveLength(0);
		expect(store.pending()).toHaveLength(0);
		// The same claim can be flagged again later.
		expect(store.scanAssistantText("[uncertain:inference] claim one", "m9")).toBe(1);
	});

	it("requeue via /verify returns a decided flag to pending", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] claim one", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified");
		expect(store.requeue(flag.id, "re-queued via /verify")).toBe(true);
		expect(store.pending()[0].staleNote).toBe("re-queued via /verify");
		// deciding again supersedes the old ruling
		store.decide(flag.id, "verified");
		expect(store.decisions()[0].decision).toBe("verified");
	});

	it("dismissing a pending flag physically removes it", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] noise claim", "m1");
		const flag = store.pending()[0];
		expect(store.decide(flag.id, "dismissed")).toBe(true);
		expect(store.pending()).toHaveLength(0);
		expect(store.decisions()).toHaveLength(0);
		expect(store.formatForVerifyPass()).toBeUndefined();
		expect(store.verifiedSectionLines()).toHaveLength(0);
		// The claim may be flagged again later.
		expect(store.scanAssistantText("[uncertain:inference] noise claim", "m9")).toBe(1);
	});

	it("remove and updateClaim rewrite the store for the dedup pass", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] old claim", "m1");
		const flag = store.pending()[0];
		expect(store.updateClaim(flag.id, "merged claim")).toBe(true);
		expect(store.pending()[0].claim).toBe("merged claim");
		expect(store.pending()[0].id).toBe(flag.id); // id and history survive
		expect(store.remove(flag.id)).toBe(true);
		expect(store.pending()).toHaveLength(0);
		expect(store.remove(flag.id)).toBe(false);
	});

	it("formatForVerifyPass renders rulings plus pending; dismissed is gone", () => {
		const store = makeStore();
		store.scanAssistantText(
			"[uncertain:inference] verified claim\n[uncertain:inference] wrong claim\n[uncertain:inference] noisy claim\n[uncertain:question] open claim",
			"m1",
		);
		const [v, w, n] = store.pending();
		store.decide(v.id, "verified");
		store.decide(w.id, "corrected", "right claim");
		store.decide(n.id, "dismissed");
		const text = store.formatForVerifyPass()!;
		expect(text).toContain('[VERIFIED, reviewed by the user] "verified claim"');
		expect(text).toContain('[CORRECTED, reviewed by the user] "wrong claim" → correction: "right claim"');
		expect(text).not.toContain("noisy claim"); // dismissed — removed entirely
		expect(text).not.toContain("[DISMISSED");
		expect(text).toContain('[PENDING] "open claim"');
	});

	it("verifiedSectionLines only includes verified and corrected", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:inference] a\n[uncertain:inference] b\n[uncertain:inference] c", "m1");
		const [a, b, c] = store.pending();
		store.decide(a.id, "verified");
		store.decide(b.id, "corrected", "b-fixed");
		store.decide(c.id, "dismissed");
		const lines = store.verifiedSectionLines();
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("- a");
		expect(lines[1]).toBe("- b → corrected to: b-fixed");
	});

	it("a requeued flag is pending-first: stale ruling never renders as fact", () => {
		const store = makeStore();
		store.scanAssistantText("[uncertain:state:src/config.ts] exports DEFAULT_GATE", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified");
		// File changed → the decision is re-queued until re-reviewed.
		expect(store.markPathModified("src/config.ts")).toBe(1);

		// The stale verified ruling must not appear as fact.
		const text = store.formatForVerifyPass()!;
		expect(text).not.toContain("[VERIFIED]");
		expect(text).toContain('[PENDING] "exports DEFAULT_GATE"');
		expect(text).toContain("(basis changed");
		expect(store.verifiedSectionLines()).toHaveLength(0);

		// Re-deciding supersedes: the ruling is fact again.
		store.decide(flag.id, "verified");
		expect(store.formatForVerifyPass()).toContain('[VERIFIED, reviewed by the user] "exports DEFAULT_GATE"');
		expect(store.verifiedSectionLines()).toEqual(["- exports DEFAULT_GATE"]);
	});

	it("persists snapshots and restores them in a new store instance", () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:state:src/x.ts] x claim", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified");
		store.scanAssistantText("[uncertain:inference] still pending", "m2");

		// Snapshot entries exist on the branch
		const branch = sm.getBranch();
		const snapshots = branch.filter((e) => e.type === "custom" && e.customType === UNCERTAINTY_SESSION_ENTRY_TYPE);
		expect(snapshots.length).toBeGreaterThan(0);

		const restored = new UncertaintyStore(sm);
		expect(restored.pending().map((f) => f.claim)).toEqual(["still pending"]);
		expect(restored.decisions()).toHaveLength(1);
		expect(restored.decisions()[0].claim).toBe("x claim");
		// Dedup state survives: re-scanning the decided claim adds nothing
		expect(restored.scanAssistantText("[uncertain:state:src/x.ts] x claim", "m3")).toBe(0);
	});

	it("skips a corrupt latest snapshot and falls back to an earlier valid one", () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:inference] recoverable claim", "m1");
		// Append a corrupt snapshot AFTER the valid one.
		sm.appendCustomEntry(UNCERTAINTY_SESSION_ENTRY_TYPE, { garbage: true });

		const restored = new UncertaintyStore(sm);
		expect(restored.pending().map((f) => f.claim)).toEqual(["recoverable claim"]);
	});

	it("prunes old snapshots after the threshold, keeping the newest", () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		// Each scan persists one snapshot; 12 scans exceed the threshold (10).
		for (let i = 0; i < 12; i++) {
			store.scanAssistantText(`[uncertain:inference] claim number ${i}`, `m${i}`);
		}
		const snapshots = sm
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === UNCERTAINTY_SESSION_ENTRY_TYPE);
		expect(snapshots.length).toBeLessThanOrEqual(10);
		// The newest state still restores fully.
		const restored = new UncertaintyStore(sm);
		expect(restored.pending()).toHaveLength(12);
	});
});
