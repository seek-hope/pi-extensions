import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummaryWithUsage } from "../context/lib/pipeline.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(
	reasoning: boolean,
	maxTokens = 8192,
	compat?: Model<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
		...(compat ? { compat } : {}),
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const _mockToolCallResponse: AssistantMessage = {
	...mockSummaryResponse,
	content: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }],
	stopReason: "toolUse",
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("Fork compaction summarization retry", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("drops the oldest round when the conversation exceeds the budget", async () => {
		// Window 20k: conversation budget ~2.3k tokens after maxTokens and the
		// fixed prompt overhead. Three rounds of ~950 tokens each exceed it, so
		// the oldest round is dropped — with full fidelity (no tool-detail
		// shedding) for the rounds that remain.
		const smallWindowModel = { ...createModel(false, 65536), contextWindow: 20_000 };
		const round = (n: number): AgentMessage[] => [
			{ role: "user" as const, content: `round ${n} question`, timestamp: Date.now() },
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: `round ${n} answer ${"a".repeat(1500)}` },
					{
						type: "toolCall" as const,
						id: `tc${n}`,
						name: "write",
						arguments: { path: "x", content: "b".repeat(1500) },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			},
			{
				role: "toolResult" as const,
				toolCallId: `tc${n}`,
				toolName: "write",
				content: [{ type: "text" as const, text: "c".repeat(2500) }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const manyRounds: AgentMessage[] = [...round(1), ...round(2), ...round(3)];

		await generateSummaryWithUsage(manyRounds, smallWindowModel, 16384, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const call = completeSimpleMock.mock.calls[0];
		const promptText = (call[1].messages[0].content[0] as { type: "text"; text: string }).text;
		expect(promptText).not.toContain("round 1 answer");
		expect(promptText).toContain("round 3 answer");
		// Kept rounds retain full fidelity: tool calls and results included.
		expect(promptText).toContain("[Assistant tool calls]");
		expect(promptText).toContain("[Tool result]");
		expect(promptText).toContain("conversation round");
		expect(promptText).not.toContain("Tool call details were omitted");
	});
	it("drops the oldest rounds one at a time until the conversation fits the budget", async () => {
		// Window 20k: conversation budget ~2.3k tokens. Three rounds of ~1.5k
		// tokens each: two oldest rounds are dropped before any API call is
		// made, the newest one fits alone.
		const smallWindowModel = { ...createModel(false, 65536), contextWindow: 20_000 };
		const round = (n: number): AgentMessage[] => [
			{ role: "user" as const, content: `round ${n} question`, timestamp: Date.now() },
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: `round ${n} answer ${"a".repeat(2000)}` },
					{
						type: "toolCall" as const,
						id: `tc${n}`,
						name: "write",
						arguments: { path: "x", content: "b".repeat(2000) },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			},
			{
				role: "toolResult" as const,
				toolCallId: `tc${n}`,
				toolName: "write",
				content: [{ type: "text" as const, text: "c".repeat(2000) }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const manyRounds: AgentMessage[] = [...round(1), ...round(2), ...round(3)];

		await generateSummaryWithUsage(manyRounds, smallWindowModel, 16384, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const call = completeSimpleMock.mock.calls[0];
		const promptText = (call[1].messages[0].content[0] as { type: "text"; text: string }).text;
		expect(promptText).toContain("round 3 answer");
		expect(promptText).not.toContain("round 1 answer");
		expect(promptText).not.toContain("round 2 answer");
		// The kept round retains full fidelity: tool calls included.
		expect(promptText).toContain("[Assistant tool calls]");
		expect(promptText).not.toContain("Tool call details were omitted");
		expect(promptText).toContain("oldest 2 conversation rounds");
		expect(call[2]?.maxTokens).toBeLessThanOrEqual(13_107);
	});
	it("drops oldest rounds one at a time on repeated provider context-overflow errors", async () => {
		const overflowResponse: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "non-reasoning-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage:
				"This model's maximum context length is 1000000 tokens. However, your messages resulted in 1500000 tokens. Please reduce the length of the messages.",
			timestamp: Date.now(),
		};
		completeSimpleMock.mockReset();
		completeSimpleMock
			.mockResolvedValueOnce(overflowResponse)
			.mockResolvedValueOnce(overflowResponse)
			.mockResolvedValueOnce(mockSummaryResponse);

		const eightMessages: AgentMessage[] = Array.from({ length: 8 }, (_, i) => ({
			role: "user" as const,
			content: `user message ${i + 1}`,
			timestamp: Date.now(),
		}));

		const result = await generateSummaryWithUsage(eightMessages, createModel(false), 16384, "test-key");

		expect(result.text).toBe("## Goal\nTest summary");
		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
		const retryPrompt = (completeSimpleMock.mock.calls[2][1].messages[0].content[0] as { type: "text"; text: string })
			.text;
		expect(retryPrompt).toContain("oldest 2 conversation rounds");
		expect(retryPrompt).toContain("user message 3");
		expect(retryPrompt).not.toContain("user message 1");
		expect(retryPrompt).not.toContain("user message 2");
	});
	it("does not retry non-overflow summarization failures", async () => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "non-reasoning-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "500 internal server error",
			timestamp: Date.now(),
		} as AssistantMessage);

		await expect(generateSummaryWithUsage(messages, createModel(false), 16384, "test-key")).rejects.toThrow(
			"Summarization failed: 500 internal server error",
		);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});
});
