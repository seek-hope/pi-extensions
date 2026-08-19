import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../context/lib/utils.ts";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	} as Message;
}

describe("Fork compaction serialization (full fidelity)", () => {
	it("never truncates tool results", () => {
		const longOutput = "o".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "write",
				content: [{ type: "text", text: longOutput }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain(longOutput);
		expect(result).not.toContain("truncated");
	});
	it("keeps failed tool result content like any other", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: "command failed: boom" }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe("[Tool result]: command failed: boom");
	});
	it("includes thinking blocks in full", () => {
		const longThinking = "t".repeat(3000);
		const messages: Message[] = [
			assistantMessage([
				{ type: "thinking", thinking: longThinking, thinkingSignature: "" },
				{ type: "text", text: "answer" },
			]),
		];

		const result = serializeConversation(messages);

		expect(result).toContain(`[Assistant thinking]: ${longThinking}`);
		expect(result).toContain("[Assistant]: answer");
	});
	it("serializes tool call arguments in full", () => {
		const longArg = "a".repeat(5000);
		const messages: Message[] = [
			assistantMessage([{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "x", content: longArg } }]),
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Assistant tool calls]: write(");
		expect(result).toContain(longArg);
		expect(result).not.toContain("truncated");
	});
});
