import { describe, expect, it } from "vitest";
import { AUTO_REVIEWED_MARKER, DISMISSED_MARKER, parseUncertainItems } from "../context/lib/review.ts";
import {
	applySummaryRulings,
	autoReviewSummaryItems,
	buildSummaryReviewPrompt,
	parseSummaryRulings,
} from "../context/lib/summary-review.ts";

const SUMMARY = `# Session Checkpoint

## Task Contract

**Goal:** finish the bg task manager

### Constraints
- [ACTIVE|explicit] no retention limits

## World State

### Model Inferences (UNVERIFIED — treat as assumptions, not facts)
- first inference
- second inference

### External State (observed values — may be stale)
- upstream-image: synced (source: sync workflow)

## Execution State

### Model Inferences (UNVERIFIED — treat as assumptions, not facts)
- newest inference
`;

describe("parseUncertainItems review markers", () => {
	it("skips entries followed by any review marker (user or auto)", () => {
		const marked = SUMMARY.replace("- second inference\n", "- second inference\n  [REVIEWED — auto-verified]\n")
			.replace("- newest inference\n", "- newest inference\n  [REVIEWED — auto-dismissed]\n")
			.replace("- first inference\n", "- first inference\n  [REVIEWED — dismissed by user]\n");
		const items = parseUncertainItems(marked);
		expect(items.map((i) => i.text)).toEqual(["upstream-image: synced (source: sync workflow)"]);
	});

	it("skips entries carrying the legacy DISMISSED_MARKER", () => {
		const marked = SUMMARY.replace("- first inference\n", `- first inference\n  ${DISMISSED_MARKER}\n`);
		const items = parseUncertainItems(marked);
		expect(items.some((i) => i.text === "first inference")).toBe(false);
	});

	it("reports unmarked entries", () => {
		const items = parseUncertainItems(SUMMARY);
		expect(items.map((i) => i.text)).toEqual([
			"first inference",
			"second inference",
			"upstream-image: synced (source: sync workflow)",
			"newest inference",
		]);
		// source lines are ascending (newest last in the summary)
		expect(items[3]!.sourceLine).toBeGreaterThan(items[0]!.sourceLine);
	});
});

describe("buildSummaryReviewPrompt", () => {
	it("orders entries newest first with kinds", () => {
		const prompt = buildSummaryReviewPrompt(
			[
				{ type: "question", text: "new question" },
				{ type: "inference", text: "old claim" },
			],
			"user: hi",
		);
		// The caller passes items newest-first; the prompt keeps that order.
		expect(prompt.indexOf("new question")).toBeLessThan(prompt.indexOf("old claim"));
		expect(prompt).toContain("[open question] new question");
		expect(prompt).toContain("[model inference] old claim");
		expect(prompt).toContain("<context>\nuser: hi\n</context>");
	});
});

describe("parseSummaryRulings", () => {
	it("parses a JSON array", () => {
		expect(
			parseSummaryRulings(
				'[{"decision":"verified"},{"decision":"dismissed"},{"decision":"corrected","correction":"fixed"}]',
			),
		).toEqual([{ decision: "verified" }, { decision: "dismissed" }, { decision: "corrected", correction: "fixed" }]);
	});

	it("tolerates markdown code fences around the array", () => {
		expect(parseSummaryRulings('```json\n[{"decision":"verified"}]\n```')).toEqual([{ decision: "verified" }]);
	});

	it("rejects malformed batches", () => {
		expect(parseSummaryRulings("no json here")).toBeUndefined();
		expect(parseSummaryRulings('[{"decision":"maybe"}]')).toBeUndefined();
		expect(parseSummaryRulings('[{"decision":"corrected"}]')).toBeUndefined(); // missing correction
		expect(parseSummaryRulings('[{"decision":"verified"}, {"nope":1}]')).toBeUndefined();
	});
});

describe("applySummaryRulings", () => {
	it("marks verified, corrected, and dismissed entries by source line", () => {
		const items = parseUncertainItems(SUMMARY);
		const ordered = [...items].reverse(); // newest first, like the reviewer sees
		const out = applySummaryRulings(SUMMARY, ordered, [
			{ decision: "dismissed" },
			{ decision: "corrected", correction: "upstream-image: behind (source: sync workflow)" },
			{ decision: "verified" },
			{ decision: "verified" },
		]);
		const outLines = out.split("\n");
		expect(outLines).not.toContain("- newest inference"); // dismissed — removed entirely
		expect(outLines).not.toContain("  [REVIEWED — auto-dismissed]");
		expect(outLines).toContain(`  ${AUTO_REVIEWED_MARKER}`);
		expect(outLines).toContain("- upstream-image: behind (source: sync workflow)");
		expect(outLines).not.toContain("- upstream-image: synced (source: sync workflow)");
		// Re-parsing yields nothing unsettled
		expect(parseUncertainItems(out)).toEqual([]);
	});

	it("drops entries the reviewer did not rule on", () => {
		const items = parseUncertainItems(SUMMARY);
		const ordered = [...items].reverse(); // newest first, like the reviewer sees
		// Only the first (newest) entry gets a ruling; the rest were not
		// confirmed and must not survive in memory.
		const out = applySummaryRulings(SUMMARY, ordered, [{ decision: "verified" }]);
		expect(parseUncertainItems(out)).toEqual([]);
		const outLines = out.split("\n");
		expect(outLines).toContain("- newest inference");
		expect(outLines).not.toContain("- first inference");
		expect(outLines).not.toContain("- second inference");
	});
});

describe("autoReviewSummaryItems", () => {
	it("settles entries via one batched completion and returns the marked summary", async () => {
		let prompt = "";
		const out = await autoReviewSummaryItems(SUMMARY, {
			model: {} as never,
			contextText: "user: latest intent",
			complete: async (p) => {
				prompt = p;
				return '[{"decision":"verified"},{"decision":"dismissed"},{"decision":"verified"},{"decision":"verified"}]';
			},
		});
		expect(prompt).toContain("newest inference"); // newest entry first in the prompt
		expect(prompt.indexOf("newest inference")).toBeLessThan(prompt.indexOf("first inference"));
		expect(parseUncertainItems(out)).toEqual([]);
	});

	it("drops the entries when the completion is unusable", async () => {
		const out = await autoReviewSummaryItems(SUMMARY, {
			model: {} as never,
			contextText: "user: hi",
			complete: async () => "I cannot decide",
		});
		expect(parseUncertainItems(out)).toEqual([]);
	});

	it("keeps the entries when the completion throws", async () => {
		const out = await autoReviewSummaryItems(SUMMARY, {
			model: {} as never,
			contextText: "user: hi",
			complete: async () => {
				throw new Error("boom");
			},
		});
		// The call failed — the model never saw the entries, so they stay.
		expect(out).toBe(SUMMARY);
	});

	it("short-circuits when there are no uncertain items", async () => {
		const clean = SUMMARY.replace(
			"### Model Inferences (UNVERIFIED — treat as assumptions, not facts)\n- first inference\n",
			"### Model Inferences (UNVERIFIED — treat as assumptions, not facts)\n",
		)
			.replace("- second inference\n", "")
			.replace(
				"### External State (observed values — may be stale)\n- upstream-image: synced (source: sync workflow)\n",
				"",
			)
			.replace("- newest inference\n", "");
		let called = false;
		const out = await autoReviewSummaryItems(clean, {
			model: {} as never,
			contextText: "",
			complete: async () => {
				called = true;
				return "[]";
			},
		});
		expect(called).toBe(false);
		expect(out).toBe(clean);
	});

	it("limits the batch to the newest entries", async () => {
		let big = SUMMARY;
		for (let i = 0; i < 30; i++) {
			big += `- extra inference ${i}\n`;
		}
		let prompt = "";
		await autoReviewSummaryItems(big, {
			model: {} as never,
			contextText: "",
			complete: async (p) => {
				prompt = p;
				return "[]";
			},
		});
		const listed = prompt.match(/\d+\. \[model inference\]/g);
		expect(listed).not.toBeNull();
		expect(listed!.length).toBeLessThanOrEqual(25);
	});
});
