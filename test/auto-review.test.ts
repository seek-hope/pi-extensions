/**
 * Tests for the auto-review pass: newest-first ordering, silent failure
 * degradation, model-ruling overrides, and user-ruling confirmation.
 */
import { describe, expect, it } from "vitest";
import { type AutoReviewCandidate, parseConflictIds, runAutoReview } from "../context/lib/auto-review.ts";
import type { UncertaintyStore } from "../context/lib/uncertainty.ts";

interface Recorded {
	id: string;
	decision: string;
	correction?: string;
	decidedBy?: string;
}

/** Store stub with pending flags + a decision log, no persistence. */
function makeStore(flags: Array<{ id: string; claim: string; type?: "inference" | "question" | "state" }>): {
	store: UncertaintyStore;
	decisions: Recorded[];
	pendingSnapshot: () => string[];
} {
	const decisions: Recorded[] = [];
	const pending = flags.map((f) => ({
		id: f.id,
		type: f.type ?? "inference",
		claim: f.claim,
		messageId: "",
	}));
	const store = {
		pending: () => [...pending],
		decide: (id: string, decision: string, correction?: string, decidedBy?: "user" | "model") => {
			const idx = pending.findIndex((f) => f.id === id);
			if (idx === -1) return false;
			pending.splice(idx, 1);
			decisions.push({ id, decision, correction, decidedBy });
			return true;
		},
		latestDecision: (id: string) => {
			for (let i = decisions.length - 1; i >= 0; i--) {
				if (decisions[i]!.id === id) return decisions[i];
			}
			return undefined;
		},
		overrideDecision: (id: string, decision: string, correction?: string, decidedBy?: "user" | "model") => {
			const prev = decisions.findIndex((d) => d.id === id);
			if (prev === -1) return false;
			decisions.push({ id, decision, correction, decidedBy });
			return true;
		},
	} as unknown as UncertaintyStore;
	return { store, decisions, pendingSnapshot: () => pending.map((f) => f.id) };
}

function candidates(flags: AutoReviewCandidate[]): AutoReviewCandidate[] {
	return flags;
}

describe("runAutoReview", () => {
	it("decides pending flags newest-first and applies rulings as model decisions", async () => {
		const { store, decisions } = makeStore([
			{ id: "old", claim: "old claim" },
			{ id: "mid", claim: "mid claim" },
			{ id: "new", claim: "new claim" },
		]);
		const reviewed: string[] = [];
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "latest conversation",
			candidates: candidates(
				["new", "mid", "old"].map((id) => ({ id, type: "inference" as const, claim: `${id} claim` })),
			),
			complete: async (prompt) => {
				for (const id of ["old", "mid", "new"]) {
					if (prompt.includes(`claim: "${id} claim"`)) {
						reviewed.push(id);
						return '{"decision":"verified"}';
					}
				}
				return '{"decision":"verified"}';
			},
		});
		// Newest flag first.
		expect(reviewed).toEqual(["new", "mid", "old"]);
		expect(result.decided).toBe(3);
		expect(result.dismissed).toBe(0);
		expect(decisions.map((d) => d.id)).toEqual(["new", "mid", "old"]);
		expect(decisions.every((d) => d.decidedBy === "model")).toBe(true);
	});

	it("applies corrected rulings with the correction text", async () => {
		const { store, decisions } = makeStore([{ id: "a", claim: "old fact" }]);
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "",
			candidates: candidates([{ id: "a", type: "inference", claim: "old fact" }]),
			complete: async () => '{"decision":"corrected","correction":"new fact"}',
		});
		expect(result.decided).toBe(1);
		expect(decisions[0]).toMatchObject({
			id: "a",
			decision: "corrected",
			correction: "new fact",
			decidedBy: "model",
		});
	});

	it("drops flags whose ruling cannot be parsed", async () => {
		const { store, decisions, pendingSnapshot } = makeStore([{ id: "a", claim: "a" }]);
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "",
			candidates: candidates([{ id: "a", type: "inference", claim: "a" }]),
			complete: async () => "I am not JSON",
		});
		expect(result.dismissed).toBe(1);
		expect(result.decided).toBe(0);
		expect(decisions[0]).toMatchObject({ id: "a", decision: "dismissed", decidedBy: "model" });
		expect(pendingSnapshot()).toEqual([]);
	});

	it("never throws when the completion call fails", async () => {
		const { store, decisions, pendingSnapshot } = makeStore([{ id: "a", claim: "a" }]);
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "",
			candidates: candidates([{ id: "a", type: "inference", claim: "a" }]),
			complete: async () => {
				throw new Error("boom");
			},
		});
		// The call failed — the model never saw the flag, so it stays pending.
		expect(result.failed).toBe(1);
		expect(decisions).toEqual([]);
		expect(pendingSnapshot()).toEqual(["a"]);
	});

	it("stops early when the signal is aborted", async () => {
		const { store, decisions } = makeStore([
			{ id: "a", claim: "a" },
			{ id: "b", claim: "b" },
		]);
		const controller = new AbortController();
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "",
			signal: controller.signal,
			candidates: candidates([
				{ id: "b", type: "inference", claim: "b" },
				{ id: "a", type: "inference", claim: "a" },
			]),
			complete: async () => {
				controller.abort(); // abort after the first call
				return '{"decision":"verified"}';
			},
		});
		expect(result.decided).toBe(1); // first candidate decided
		expect(decisions.length).toBe(1); // second never called
	});

	it("overturns model rulings directly without confirmation", async () => {
		// A model-decided flag is re-reviewed and dismissed outright.
		const { store, decisions } = makeStore([{ id: "a", claim: "a" }]);
		// First decide it as the model (via decide), then re-review as a decided entry.
		expect(store.decide("a", "verified", undefined, "model")).toBe(true);
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "new context",
			candidates: candidates([{ id: "a", type: "inference", claim: "a" }]),
			complete: async () => '{"decision":"dismissed"}',
		});
		expect(result.overridden).toBe(1);
		expect(decisions.at(-1)).toMatchObject({ id: "a", decision: "dismissed", decidedBy: "model" });
	});

	it("proposes overturning user rulings and applies only when confirmed", async () => {
		const { store, decisions } = makeStore([{ id: "a", claim: "user-ruled claim" }]);
		expect(store.decide("a", "verified", undefined, "user")).toBe(true);
		const proposals: string[] = [];
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "new context",
			candidates: candidates([{ id: "a", type: "inference", claim: "user-ruled claim" }]),
			complete: async () => '{"decision":"dismissed"}',
			onUserOverrideProposal: async (proposal) => {
				proposals.push(proposal.flagId);
				return true; // user confirmed in the popup
			},
		});
		expect(result.proposed).toBe(1);
		expect(proposals).toEqual(["a"]);
		expect(decisions.at(-1)).toMatchObject({ id: "a", decision: "dismissed", decidedBy: "user" });
	});

	it("keeps user rulings when the confirmation is declined", async () => {
		const { store, decisions } = makeStore([{ id: "a", claim: "user-ruled claim" }]);
		expect(store.decide("a", "verified", undefined, "user")).toBe(true);
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "new context",
			candidates: candidates([{ id: "a", type: "inference", claim: "user-ruled claim" }]),
			complete: async () => '{"decision":"dismissed"}',
			onUserOverrideProposal: async () => false, // popup declined / timeout
		});
		expect(result.proposed).toBe(1);
		expect(decisions).toHaveLength(1); // unchanged
		expect(decisions[0]).toMatchObject({ decision: "verified", decidedBy: "user" });
	});

	it("skips candidates whose ruling did not change", async () => {
		const { store, decisions } = makeStore([{ id: "a", claim: "a" }]);
		expect(store.decide("a", "verified", undefined, "user")).toBe(true);
		const result = await runAutoReview(store, {
			model: undefined as never,
			contextText: "",
			candidates: candidates([{ id: "a", type: "inference", claim: "a" }]),
			complete: async () => '{"decision":"verified"}',
		});
		expect(result.skipped).toBe(1);
		expect(result.proposed).toBe(0);
		expect(decisions).toHaveLength(1);
	});
});

describe("parseConflictIds", () => {
	it("parses a JSON array of ids", () => {
		expect(parseConflictIds('["u123","u456"]')).toEqual(["u123", "u456"]);
		expect(parseConflictIds('Here are the conflicts: ["u1"]')).toEqual(["u1"]);
	});

	it("returns [] for no conflicts or malformed output", () => {
		expect(parseConflictIds("[]")).toEqual([]);
		expect(parseConflictIds("no conflicts")).toEqual([]);
		expect(parseConflictIds("[1,2]")).toEqual([]);
	});
});
