/**
 * Tests for context pruning (compaction/prune.ts).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "../context/lib/prune.ts";

let nextId = 0;
function toolResult(toolName: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${(nextId++).toString().padStart(8, "0")}-xyz`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

const BIG = "x".repeat(10_000); // ~2500 tok

describe("pruneContextMessages", () => {
	it("replaces old over-threshold outputs with metadata-only stubs", () => {
		const messages = [
			userMessage("go"),
			toolResult("read", BIG), // call-00000000-xyz — eligible, pruned
			toolResult("bash", BIG), // call-00000001-xyz — eligible, protected (most recent)
			toolResult("read", "small"), // under threshold, untouched
		];
		const {
			messages: pruned,
			prunedCount,
			prunedTokens,
		} = pruneContextMessages(messages, {
			keepRecentToolResults: 1,
		});

		expect(prunedCount).toBe(1);
		expect(prunedTokens).toBeGreaterThan(2000);
		const stub = (pruned[1] as { content: Array<{ text: string }> }).content[0].text;
		// Metadata only: tool, size, line count, recall handle — no content.
		expect(stub).toBe('[pruned read output — ~2500 tok, 1 line. Full output: recall with toolCallId "call-000".]');
		expect(stub).not.toContain("xxxx");
		// Protected recent eligible output and small output untouched.
		expect((pruned[2] as { content: Array<{ text: string }> }).content[0].text).toBe(BIG);
		expect((pruned[3] as { content: Array<{ text: string }> }).content[0].text).toBe("small");
	});

	it("keeps the N most recent eligible outputs intact", () => {
		const messages = [toolResult("read", BIG), toolResult("read", BIG), toolResult("read", BIG)];
		const { prunedCount } = pruneContextMessages(messages, { keepRecentToolResults: 3 });
		expect(prunedCount).toBe(0);
	});

	it("counts only eligible outputs toward the recency protection", () => {
		// Two eligible BIG reads with a small (ineligible) result between them:
		// protection of 1 covers the LAST ELIGIBLE output, not the last result.
		const messages = [
			toolResult("read", BIG), // eligible, pruned
			toolResult("read", "small"), // ineligible (under threshold)
			toolResult("bash", BIG), // eligible, protected
		];
		const { messages: pruned, prunedCount } = pruneContextMessages(messages, { keepRecentToolResults: 1 });
		expect(prunedCount).toBe(1);
		expect((pruned[0] as { content: Array<{ text: string }> }).content[0].text).toContain("[pruned read output");
		expect((pruned[2] as { content: Array<{ text: string }> }).content[0].text).toBe(BIG);
	});

	it("reports multi-line outputs with their line count", () => {
		const content = Array.from({ length: 500 }, (_, i) => `line-${i}-${"z".repeat(30)}`).join("\n");
		const { messages: pruned, prunedCount } = pruneContextMessages([toolResult("bash", content)], {
			keepRecentToolResults: 0,
		});
		expect(prunedCount).toBe(1);
		const stub = (pruned[0] as { content: Array<{ text: string }> }).content[0].text;
		expect(stub).toContain("500 lines");
		expect(stub).not.toContain("line-0");
		expect(stub).toContain('recall with toolCallId "');
	});

	it("skips error results, non-read-only tools, images, small outputs, and existing stubs", () => {
		const messages = [
			toolResult("bash", BIG, true), // error
			toolResult("write", BIG), // not read-only
			toolResult("read", "short"), // small
			toolResult("read", "[pruned read output — already]"), // idempotent
			toolResult("edit", BIG), // not read-only
		];
		const { prunedCount } = pruneContextMessages(messages, { keepRecentToolResults: 0 });
		expect(prunedCount).toBe(0);
	});

	it("skips tool results containing images", () => {
		const imageResult = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [
				{ type: "text", text: BIG },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const { prunedCount } = pruneContextMessages([imageResult], { keepRecentToolResults: 0 });
		expect(prunedCount).toBe(0);
	});

	it("honors minPrunableTokens and enabled=false", () => {
		const messages = [toolResult("read", BIG)];
		expect(pruneContextMessages(messages, { keepRecentToolResults: 0, minPrunableTokens: 9999 }).prunedCount).toBe(0);
		expect(pruneContextMessages(messages, { keepRecentToolResults: 0, enabled: false }).prunedCount).toBe(0);
		expect(pruneContextMessages(messages, { keepRecentToolResults: 0 }).prunedCount).toBe(1);
	});

	it("replaces only the first text part and drops the rest (no stub duplication)", () => {
		const multiPart = {
			role: "toolResult",
			toolCallId: "call-c1",
			toolName: "bash",
			content: [
				{ type: "text", text: BIG },
				{ type: "text", text: BIG },
				{ type: "text", text: BIG },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const { messages: pruned, prunedCount } = pruneContextMessages([multiPart], { keepRecentToolResults: 0 });
		expect(prunedCount).toBe(1);
		const content = (pruned[0] as { content: Array<{ type: string; text: string }> }).content;
		expect(content).toHaveLength(1);
		expect(content[0].text.startsWith("[pruned bash output")).toBe(true);
		// Stub appears exactly once
		expect(content[0].text.split("[pruned bash output").length - 1).toBe(1);
	});
});
