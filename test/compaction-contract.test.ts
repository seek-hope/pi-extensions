/**
 * Tests for the task contract layer (compaction/contract.ts).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildConversationJson, extractJsonObject, normalizeContract } from "../context/lib/contract.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function assistant(
	text: string,
	toolCall?: { id: string; name: string; arguments: Record<string, unknown> },
): AgentMessage {
	const content: unknown[] = [{ type: "text", text }];
	if (toolCall) content.push({ type: "toolCall", ...toolCall });
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AgentMessage;
}

function toolResultMsg(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

describe("normalizeContract", () => {
	it("fills defaults and drops invalid items", () => {
		const contract = normalizeContract({
			goal: "ship the feature",
			constraints: [
				{ text: "must not touch prod", status: "active", authority: "explicit" },
				{ text: "bad status", status: "weird" },
				{ noText: true },
				"garbage",
			],
			decisions: [{ text: "use local cache", rationale: "no external services" }, { text: 42 }],
			unresolved: ["capacity limit?", ""],
		});

		expect(contract.goal).toBe("ship the feature");
		expect(contract.constraints).toHaveLength(2);
		expect(contract.constraints[1].status).toBe("active"); // invalid → default
		expect(contract.decisions).toHaveLength(1);
		expect(contract.unresolved).toEqual(["capacity limit?"]);
	});

	it("keeps supersession links", () => {
		const contract = normalizeContract({
			goal: "g",
			constraints: [
				{ text: "no external services", status: "active", authority: "explicit" },
				{ text: "use Redis", status: "superseded", authority: "explicit", supersededBy: "no external services" },
			],
		});
		expect(contract.constraints[1]).toMatchObject({ status: "superseded", supersededBy: "no external services" });
	});

	it("returns an empty contract for garbage input", () => {
		expect(normalizeContract(undefined).goal).toBe("");
		expect(normalizeContract("nope").constraints).toHaveLength(0);
	});
});

describe("extractJsonObject", () => {
	it("parses fenced and raw JSON", () => {
		expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(extractJsonObject('prose {"a":2} trailing')).toEqual({ a: 2 });
		expect(extractJsonObject("no json here")).toBeUndefined();
	});
});

describe("buildConversationJson", () => {
	it("serializes user and assistant messages as role-tagged JSON, untruncated", () => {
		const longText = `prefix ${"x".repeat(5000)}`;
		const json = buildConversationJson([
			user(longText),
			assistant("assistant reasoning stays visible but marked untrusted"),
		]);
		const entries = JSON.parse(json);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual({ role: "user", text: longText });
		expect(entries[1].role).toBe("assistant");
		expect(entries[1].text).toContain("untrusted");
	});

	it("lists assistant tool calls by name", () => {
		const json = buildConversationJson([
			assistant("editing now", { id: "c1", name: "edit", arguments: { path: "a.ts" } }),
		]);
		const entries = JSON.parse(json);
		expect(entries[0].toolCalls).toEqual(["edit"]);
	});

	it("omits tool results and can drop assistant entries for size fallback", () => {
		const json = buildConversationJson([user("hi"), assistant("reasoning"), toolResultMsg("huge output")], {
			userOnly: true,
		});
		const entries = JSON.parse(json);
		expect(entries).toEqual([{ role: "user", text: "hi" }]);
	});
});
