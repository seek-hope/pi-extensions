import { describe, expect, it } from "vitest";
import { collectDedupEntries, parseDedupRulings, runContentDedup } from "../context/lib/content-dedup.ts";
import { UncertaintyStore } from "../context/lib/uncertainty.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

describe("content-dedup collect", () => {
	it("orders pending then decided, newest first", () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:inference] oldest claim", "m1");
		store.scanAssistantText("[uncertain:inference] newest claim", "m2");
		const [a, b] = store.pending();
		store.decide(a.id, "verified");
		const entries = collectDedupEntries(store);
		expect(entries.map((e) => e.claim)).toEqual(["newest claim", "oldest claim"]);
		expect(entries[1]).toMatchObject({ id: a.id, decided: true });
		expect(entries[0]).toMatchObject({ id: b.id, decided: false });
	});
});

describe("parseDedupRulings", () => {
	it("parses a JSON array with keep/delete/rewrite", () => {
		expect(
			parseDedupRulings(
				'[{"id":"u1","action":"keep"},{"id":"u2","action":"delete"},{"id":"u3","action":"rewrite","text":"merged"}]',
			),
		).toEqual([
			{ id: "u1", action: "keep" },
			{ id: "u2", action: "delete" },
			{ id: "u3", action: "rewrite", text: "merged" },
		]);
	});

	it("rejects malformed batches", () => {
		expect(parseDedupRulings("nope")).toBeUndefined();
		expect(parseDedupRulings('[{"action":"delete"}]')).toBeUndefined(); // missing id
		expect(parseDedupRulings('[{"id":"u1","action":"maybe"}]')).toBeUndefined();
		expect(parseDedupRulings('[{"id":"u1","action":"rewrite"}]')).toBeUndefined(); // missing text
	});
});

describe("runContentDedup", () => {
	it("deletes duplicate/conflicting flags and rewrites survivors", async () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:inference] the API retries on 429", "m1");
		store.scanAssistantText("[uncertain:inference] the API retries on 429 with backoff", "m2"); // near-duplicate
		store.scanAssistantText("[uncertain:state:src/a.ts] A exports X", "m3");
		store.scanAssistantText("[uncertain:state:src/b.ts] B exports Y", "m4");
		const flags = store.pending();
		const [d1, d2, s1, s2] = flags;
		expect(flags).toHaveLength(4);

		let prompt = "";
		const result = await runContentDedup(store, {
			model: undefined as never,
			complete: async (p) => {
				prompt = p;
				// Entries are newest first: s2, s1, d2, d1.
				return JSON.stringify([
					{ id: s2.id, action: "rewrite", text: "src/b.ts and src/a.ts both export symbols" },
					{ id: s1.id, action: "delete" },
					{ id: d2.id, action: "keep" },
					{ id: d1.id, action: "delete" },
				]);
			},
		});
		expect(prompt).toContain("NEWEST first");
		expect(result.removed).toBe(2);
		expect(result.rewritten).toBe(1);
		expect(store.pending()).toHaveLength(2);
		expect(store.pending().map((f) => f.claim)).toEqual([
			"the API retries on 429 with backoff",
			"src/b.ts and src/a.ts both export symbols",
		]);
	});

	it("removes decided flags too and skips mismatched ids", async () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:inference] decided claim", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified");
		const result = await runContentDedup(store, {
			model: undefined as never,
			complete: async () => '[{"id":"u-wrong-id","action":"delete"},{"id":"u-also-wrong","action":"delete"}]',
		});
		// ids do not align with the entry → nothing applied
		expect(result.removed).toBe(0);
		expect(store.decisions()).toHaveLength(1);
	});

	it("never deletes a user-ruled entry without confirmation", async () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:inference] user-backed fact", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified"); // decidedBy defaults to "user"

		// Declined confirmation → entry stays.
		const declined = await runContentDedup(store, {
			model: undefined as never,
			complete: async () => JSON.stringify([{ id: flag.id, action: "delete" }]),
			onUserOverrideProposal: async () => false,
		});
		expect(declined.removed).toBe(0);
		expect(store.decisions()).toHaveLength(1);

		// No hook at all → entry stays.
		const noHook = await runContentDedup(store, {
			model: undefined as never,
			complete: async () => JSON.stringify([{ id: flag.id, action: "delete" }]),
		});
		expect(noHook.removed).toBe(0);
		expect(store.decisions()).toHaveLength(1);

		// Accepted confirmation → entry is removed.
		const proposals: string[] = [];
		const accepted = await runContentDedup(store, {
			model: undefined as never,
			complete: async () => JSON.stringify([{ id: flag.id, action: "delete" }]),
			onUserOverrideProposal: async (p) => {
				proposals.push(p.flagId);
				return true;
			},
		});
		expect(accepted.removed).toBe(1);
		expect(proposals).toEqual([flag.id]);
		expect(store.decisions()).toHaveLength(0);
	});

	it("deletes model-ruled entries without asking", async () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:inference] model-backed claim", "m1");
		const flag = store.pending()[0];
		store.decide(flag.id, "verified", undefined, "model");
		let asked = false;
		const result = await runContentDedup(store, {
			model: undefined as never,
			complete: async () => JSON.stringify([{ id: flag.id, action: "delete" }]),
			onUserOverrideProposal: async () => {
				asked = true;
				return false;
			},
		});
		expect(result.removed).toBe(1);
		expect(asked).toBe(false);
	});

	it("returns untouched when the completion is unusable or throws", async () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		store.scanAssistantText("[uncertain:inference] claim", "m1");
		const before = store.pending().length;
		expect(
			(await runContentDedup(store, { model: undefined as never, complete: async () => "garbage" })).removed,
		).toBe(0);
		expect(
			(
				await runContentDedup(store, {
					model: undefined as never,
					complete: async () => {
						throw new Error("boom");
					},
				})
			).removed,
		).toBe(0);
		expect(store.pending()).toHaveLength(before);
	});

	it("short-circuits with no flags", async () => {
		const sm = SessionManager.inMemory();
		const store = new UncertaintyStore(sm);
		let called = false;
		const result = await runContentDedup(store, {
			model: undefined as never,
			complete: async () => {
				called = true;
				return "[]";
			},
		});
		expect(called).toBe(false);
		expect(result.removed).toBe(0);
	});
});
