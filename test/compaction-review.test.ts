import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISMISSED_MARKER, dismissItems, parseUncertainItems } from "../context/lib/review.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const SUMMARY = `# Summary

## Goal
Do things.

### Model Inferences (UNVERIFIED)
- Inference one
- Inference two

### Open Questions
- Question one

### External State
- CI is green

## Done
Stuff.
`;

describe("parseUncertainItems", () => {
	it("parses items from all uncertain sections", () => {
		const items = parseUncertainItems(SUMMARY);
		expect(items.map((i) => i.type)).toEqual(["inference", "inference", "question", "state"]);
	});

	it("skips items carrying the dismissed marker on the next line", () => {
		const dismissed = dismissItems(SUMMARY, new Set([parseUncertainItems(SUMMARY)[0].sourceLine]));
		const items = parseUncertainItems(dismissed);
		expect(items.map((i) => i.text)).toEqual(["Inference two", "Question one", "CI is green"]);
	});

	it("returns no items after every item was dismissed", () => {
		const all = parseUncertainItems(SUMMARY);
		const dismissed = dismissItems(SUMMARY, new Set(all.map((i) => i.sourceLine)));
		expect(parseUncertainItems(dismissed)).toEqual([]);
	});
});

describe("dismissItems", () => {
	it("inserts the marker directly after the dismissed line", () => {
		const target = parseUncertainItems(SUMMARY)[0];
		const out = dismissItems(SUMMARY, new Set([target.sourceLine]));
		const lines = out.split("\n");
		expect(lines[target.sourceLine + 1].trim()).toBe(DISMISSED_MARKER);
	});

	it("is a no-op for an empty set", () => {
		expect(dismissItems(SUMMARY, new Set())).toBe(SUMMARY);
	});
});

describe("compaction review persistence", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-review-test-"));
		sessionDir = join(tempDir, "sessions");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSessionWithCompaction(details?: Record<string, unknown>): { sm: SessionManager; entryId: string } {
		const sm = SessionManager.create(tempDir, sessionDir);
		const msgId = sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const entryId = sm.appendCompaction(SUMMARY, msgId, 5000, details);
		return { sm, entryId };
	}



	it("getLatestCompactionEntry returns the newest compaction on the branch", () => {
		const { sm } = createSessionWithCompaction();
		sm.appendMessage({ role: "user", content: "more work", timestamp: Date.now() });
		const secondMsg = sm.appendMessage({ role: "user", content: "done", timestamp: Date.now() });
		const secondId = sm.appendCompaction("# Second\n\n### Open Questions\n- q\n", secondMsg, 9000);

		const latest = sm.getLatestCompactionEntry();
		expect(latest?.id).toBe(secondId);
	});

	it("getLatestCompactionEntry returns undefined without compactions", () => {
		const sm = SessionManager.create(tempDir, sessionDir);
		sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		expect(sm.getLatestCompactionEntry()).toBeUndefined();
	});
});
