import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	prepareCompaction,
} from "../context/lib/pipeline.ts";
import {
	type CompactionEntry,
	type CustomMessageEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// Test fixtures
// ============================================================================

function _loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function _createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function _createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

function createCustomMessageEntry(content: string): CustomMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		customType: "test",
		content,
		display: true,
	};
	lastId = id;
	return entry;
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Fork compaction (round-based cut)", () => {
	it("keeps the most recent N rounds", () => {
		// 10 rounds (user+assistant pairs). Keep 2: cut at the user message
		// that starts round 9 (index 16).
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		const result = findCutPoint(entries, 0, entries.length, 2);

		expect(result.firstKeptEntryIndex).toBe(16);
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role).toBe("user");
	});
	it("should return startIndex if no round starts in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 2);
		expect(result.firstKeptEntryIndex).toBe(0);
	});
	it("keeps everything when there are fewer rounds than the budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 2);
		expect(result.firstKeptEntryIndex).toBe(0);
	});
	it("never splits a round, however large it is", () => {
		// One huge round: the cut always lands on the round boundary (the user
		// message), keeping the huge round raw.
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")), // index 0
			createMessageEntry(createAssistantMessage("A1")), // index 1
			createMessageEntry(createUserMessage(`Turn 2 huge: ${"x".repeat(4000)}`)), // index 2
			createMessageEntry(createAssistantMessage("A2")), // index 3
		];

		const result = findCutPoint(entries, 0, entries.length, 1);

		expect(result.firstKeptEntryIndex).toBe(2);
	});
	it("treats custom messages as round boundaries", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("hi")),
			createMessageEntry(createAssistantMessage("hello")),
			createCustomMessageEntry("x".repeat(4000)),
			createMessageEntry(createAssistantMessage("ok")),
		];

		// 2 rounds (user@0, custom@2): keep 1 → cut at the custom message.
		const keepOne = findCutPoint(entries, 0, entries.length, 1);
		expect(keepOne.firstKeptEntryIndex).toBe(2);

		// Keep 2 → the whole range is kept.
		const keepTwo = findCutPoint(entries, 0, entries.length, 2);
		expect(keepTwo.firstKeptEntryIndex).toBe(0);
	});
	it("should skip repeated compactions when nothing new needs summarizing", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		// Two rounds after the boundary (u2, u4) with keepRecentRounds = 2:
		// everything is kept, nothing left to summarize.
		const pathEntries = [u1, a1, u2, a2, compaction1, u4, a4];
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeUndefined();
	});
	it("advances the cut boundary across successive compactions", () => {
		// First session: keep the last round (u2/a2), summarize u1/a1.
		const u1 = createMessageEntry(createUserMessage("User: hello-summarized")); // index 0
		const a1 = createMessageEntry(createAssistantMessage("assistant: world")); // index 1
		const u2 = createMessageEntry(createUserMessage(`User: ${"Z".repeat(4000)}`)); // index 2 (huge)
		const a2 = createMessageEntry(createAssistantMessage("assistant: first-reply-kept")); // index 3
		const firstSession: SessionEntry[] = [u1, a1, u2, a2];

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentRounds: 1,
		};

		const firstPrep = prepareCompaction(firstSession, settings);
		expect(firstPrep).toBeDefined();
		expect(firstPrep!.firstKeptEntryId).toBe(u2.id);
		expect(extractText(firstPrep!.messagesToSummarize)).toBe("User: hello-summarized\nassistant: world");
		expect(firstPrep!.previousSummary).toBeUndefined();

		// Append a compaction entry for the first compaction plus new rounds.
		const compaction1 = createCompactionEntry("Prior summary", u2.id); // index 4
		const u3 = createMessageEntry(createUserMessage("User: mid")); // index 5
		const a3 = createMessageEntry(createAssistantMessage("assistant: mid reply")); // index 6
		const u4 = createMessageEntry(createUserMessage(`User: ${"Q".repeat(4000)}`)); // index 7 (huge)
		const a4 = createMessageEntry(createAssistantMessage("assistant: huge2 reply")); // index 8
		const secondSession: SessionEntry[] = [u1, a1, u2, a2, compaction1, u3, a3, u4, a4];

		const secondPrep = prepareCompaction(secondSession, settings);
		expect(secondPrep).toBeDefined();

		// The walk resumes from the previous compaction boundary (u2): messages
		// already folded into "Prior summary" (u1, a1) are not re-summarized,
		// while u2 — kept raw last time — is summarized now.
		const secondSummarized = extractText(secondPrep!.messagesToSummarize);
		expect(secondSummarized).toContain("Z".repeat(4000));
		expect(secondSummarized).toContain("assistant: first-reply-kept");
		expect(secondSummarized).toContain("User: mid");
		expect(secondSummarized).toContain("assistant: mid reply");
		expect(secondSummarized).not.toContain("User: hello-summarized");
		expect(secondSummarized).not.toContain("Q".repeat(4000));
		expect(secondSummarized).not.toContain("Prior summary");

		// The previous summary is threaded through as an update source.
		expect(secondPrep!.previousSummary).toBe("Prior summary");

		// The cut advances past the previous boundary and never regresses.
		expect(secondPrep!.firstKeptEntryId).toBe(u4.id);
		expect(
			secondPrep!.messagesToSummarize.some(
				(m) => m.role === "assistant" && extractText([m]).includes("first-reply-kept"),
			),
		).toBe(true);
	});
	it("skips already-summarized regions and merges the previous summary on a non-split continuation", () => {
		// First compaction keeps the newest round (u2/a2) and summarizes the
		// earlier region (u1/a1) with a non-split cut at the u2 user message.
		const u1 = createMessageEntry(createUserMessage("User: base")); // index 0
		const a1 = createMessageEntry(createAssistantMessage("assistant: base reply")); // index 1
		const u2 = createMessageEntry(createUserMessage("User: second")); // index 2
		const a2 = createMessageEntry(createAssistantMessage("assistant: second reply")); // index 3

		const keepOne: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentRounds: 1,
		};
		const firstPrep = prepareCompaction([u1, a1, u2, a2], keepOne);
		expect(firstPrep).toBeDefined();
		expect(firstPrep!.firstKeptEntryId).toBe(u2.id);
		expect(extractText(firstPrep!.messagesToSummarize)).toBe("User: base\nassistant: base reply");

		// A later compaction appends rounds after the first compaction's entry.
		// Round-walk resumes past the boundary, so the already-summarized region
		// (u1/a1) is skipped; the old summary is threaded through previousSummary.
		const compaction1 = createCompactionEntry("update me", u2.id); // index 4
		const u3 = createMessageEntry(createUserMessage("User: after")); // index 5
		const a3 = createMessageEntry(createAssistantMessage("assistant: after reply")); // index 6
		const secondPrep = prepareCompaction([u1, a1, u2, a2, compaction1, u3, a3], keepOne);
		expect(secondPrep).toBeDefined();

		expect(secondPrep!.previousSummary).toBe("update me");
		expect(secondPrep!.firstKeptEntryId).toBe(u3.id);

		// Summarize window covers the previously kept round (u2/a2) merged with
		// the old summary, never re-touching the already-summarized region.
		const summarized = extractText(secondPrep!.messagesToSummarize);
		expect(summarized).toContain("User: second");
		expect(summarized).toContain("assistant: second reply");
		expect(summarized).not.toContain("User: base");
		expect(summarized).not.toContain("assistant: base reply");
		expect(summarized).not.toContain("User: after");
		expect(summarized).not.toContain("assistant: after reply");
		expect(summarized).not.toContain("update me");
	});
});
