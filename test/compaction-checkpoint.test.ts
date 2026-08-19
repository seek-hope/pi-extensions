/**
 * Tests for the structured checkpoint pipeline (compaction/checkpoint.ts).
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { applyCorrections, assembleCheckpoint, compactStructured } from "../context/lib/checkpoint.ts";
import type { CompactionPreparation } from "../context/lib/pipeline.ts";
import { emptyLedger } from "../context/lib/ledger.ts";
import { createFileOps } from "@earendil-works/pi-coding-agent";

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

function toolResult(toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function queueStreamFn(...texts: string[]): {
	streamFn: StreamFn;
	calls: Array<{ context: Context; options: SimpleStreamOptions }>;
} {
	const calls: Array<{ context: Context; options: SimpleStreamOptions }> = [];
	let i = 0;
	const streamFn = (async (_model: unknown, context: Context, options: SimpleStreamOptions) => {
		calls.push({ context, options });
		const text = texts[Math.min(i++, texts.length - 1)];
		return { result: async () => assistantMessage(text) };
	}) as unknown as StreamFn;
	return { streamFn, calls };
}

function makePreparation(messages: AgentMessage[]): CompactionPreparation {
	return {
		firstKeptEntryId: "keep-1",
		messagesToSummarize: messages,
		tokensBefore: 50_000,
		fileOps: createFileOps(),
		settings: { enabled: true, reserveTokens: 16384, keepRecentRounds: 8 },
	};
}

describe("compactStructured", () => {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;

	it("produces a four-layer checkpoint from two LLM passes plus the ledger", async () => {
		const contractJson = JSON.stringify({
			goal: "Implement an in-process cache",
			constraints: [
				{ text: "No external services", status: "active", authority: "explicit" },
				{ text: "Use Redis", status: "superseded", authority: "explicit", supersededBy: "No external services" },
			],
			decisions: [{ text: "Local in-process cache", rationale: "no external services allowed" }],
			unresolved: ["Capacity limit?"],
		});
		const verifyJson = JSON.stringify({
			corrections: { missingConstraints: ["Must support TTL"], revived: [], contradictions: [] },
			executionState: {
				currentApproach: "In-process cache with TTL",
				done: ["Created src/cache.ts"],
				inProgress: ["Fixing concurrent eviction"],
				nextSteps: ["Fix test_ttl_expiry", "Run full test suite"],
				modelInferences: ["Assumed lock granularity is the cause of the eviction failure"],
				externalState: [
					{ property: "pytest status", value: "18 passed, 2 failed", source: "bash", refresh: "re-run pytest" },
				],
			},
		});
		const { streamFn, calls } = queueStreamFn(contractJson, verifyJson);

		const preparation = makePreparation([
			user("Implement a cache. Must not use external services."),
			assistant("I'll design a Redis cache.", { id: "c1", name: "write", arguments: { path: "src/cache.ts" } }),
			toolResult("c1", "ok"),
			user("No external services allowed — redesign in-process."),
			assistant("Redesigned as in-process cache.", { id: "c2", name: "bash", arguments: { command: "pytest" } }),
			toolResult("c2", "18 passed, 2 failed"),
		]);

		const result = await compactStructured(preparation, {}, model, undefined, { streamFn });

		// Pass A receives the full conversation as role-tagged JSON: user intent
		// is authoritative, the assistant trajectory is present but marked
		// untrusted (the model distinguishes via the role field + prompt).
		const passAText = JSON.stringify(calls[0].context.messages);
		expect(passAText).toContain("is authoritative");
		const firstContent = calls[0].context.messages[0].content;
		const passAJson =
			typeof firstContent === "string" ? firstContent : firstContent[0].type === "text" ? firstContent[0].text : "";
		expect(passAJson).toContain('"role": "assistant"');
		expect(passAJson).toContain('"role": "user"');
		expect(passAJson).toContain("design a Redis cache"); // present, but marked untrusted

		// Checkpoint structure
		expect(result.summary).toContain("# Session Checkpoint");
		expect(result.summary).toContain("## Task Contract");
		expect(result.summary).toContain("**Goal:** Implement an in-process cache");
		expect(result.summary).toContain("[SUPERSEDED] Use Redis → replaced by: No external services");
		expect(result.summary).toContain("[ACTIVE|explicit] Must support TTL"); // correction applied
		expect(result.summary).toContain("## World State");
		expect(result.summary).toContain("## Execution State");
		expect(result.summary).toContain("Fixing concurrent eviction");
		expect(result.summary).toContain("UNVERIFIED");
		expect(result.summary).toContain("pytest status: 18 passed, 2 failed (source: bash, refresh: re-run pytest)");
		expect(result.summary).toContain("## Verification Notes");
		expect(result.summary).toContain("Added missing constraint: Must support TTL");

		// Machine-readable artifacts for the next compaction round
		expect(result.contract.goal).toBe("Implement an in-process cache");
		expect(result.ledger.files.map((f) => f.path)).toContain("src/cache.ts");
	});

	it("includes the L1/L2 file context when provided", async () => {
		const contractJson = JSON.stringify({
			goal: "g",
			constraints: [],
			decisions: [],
			unresolved: [],
		});
		const verifyJson = JSON.stringify({
			corrections: { missingConstraints: [], revived: [], contradictions: [] },
			executionState: {},
		});
		const { streamFn } = queueStreamFn(contractJson, verifyJson);

		const preparation = makePreparation([user("hi")]);
		const result = await compactStructured(preparation, {}, model, undefined, { streamFn }, undefined, undefined, {
			files: [
				{ path: "/x/a.ts", source: "read", at: 2 },
				{ path: "/x/b.ts", source: "write", at: 1 },
			],
			stale: ["/x/c.ts"],
		});

		expect(result.summary).toContain("### Files (L1 — most recently contacted first)");
		expect(result.summary).toContain("- /x/a.ts (read)");
		expect(result.summary).toContain("- /x/b.ts (write)");
		expect(result.summary).toContain("### External Changes (L2)");
		expect(result.summary).toContain("- /x/c.ts");
		expect(result.summary).not.toContain("### Commands");
		expect(result.summary).not.toContain("### Files Modified");
	});

	it("merges the previous contract and ledger on the next round", async () => {
		const contractJson = JSON.stringify({
			goal: "Cache v2",
			constraints: [{ text: "No external services", status: "active", authority: "explicit" }],
			decisions: [],
			unresolved: [],
		});
		const verifyJson = JSON.stringify({ corrections: {}, executionState: { done: ["v2 shipped"] } });
		const { streamFn } = queueStreamFn(contractJson, verifyJson);

		const previousLedger = emptyLedger();
		previousLedger.files.push({ type: "edit", path: "src/old.ts", status: "ok" });
		const previousContract = {
			goal: "Cache v1",
			constraints: [{ text: "No external services", status: "active" as const, authority: "explicit" as const }],
			decisions: [],
			unresolved: [],
		};

		const result = await compactStructured(
			makePreparation([user("continue")]),
			{ contract: previousContract, ledger: previousLedger },
			model,
			undefined,
			{ streamFn },
		);
		expect(result.contract.goal).toBe("Cache v2");
		expect(result.ledger.files.map((f) => f.path)).toContain("src/old.ts");
	});

	it("throws when the contract pass returns no JSON (caller falls back)", async () => {
		const { streamFn } = queueStreamFn("no json at all");
		await expect(
			compactStructured(makePreparation([user("hi")]), {}, model, undefined, { streamFn }),
		).rejects.toThrow(/parseable JSON/);
	});
});

describe("applyCorrections", () => {
	it("revives wrongly superseded constraints", () => {
		const contract = {
			goal: "g",
			constraints: [
				{
					text: "use postgres",
					status: "superseded" as const,
					authority: "explicit" as const,
					supersededBy: "use sqlite",
				},
			],
			decisions: [],
			unresolved: [],
		};
		const notes = applyCorrections(contract, { missingConstraints: [], revived: ["postgres"], contradictions: [] });
		expect(contract.constraints[0].status).toBe("active");
		expect(contract.constraints[0].supersededBy).toBeUndefined();
		expect(notes[0]).toContain("Revived");
	});
});

describe("assembleCheckpoint", () => {
	it("renders all sections with proper markers", () => {
		const md = assembleCheckpoint({
			contract: {
				goal: "g",
				constraints: [{ text: "c1", status: "active", authority: "explicit" }],
				decisions: [{ text: "d1", rationale: "r" }],
				unresolved: ["q1"],
			},
			executionState: { nextSteps: ["a", "b"], modelInferences: ["maybe x"] },
			fileContext: {
				files: [
					{ path: "b.ts", source: "edit", at: 2 },
					{ path: "a.ts", source: "read", at: 1 },
				],
				stale: ["c.ts"],
			},
			verificationNotes: [],
			tokensBefore: 1234,
		});
		expect(md).toContain("the contract wins");
		expect(md).toContain("1. a\n2. b");
		expect(md).toContain("UNVERIFIED");
		expect(md).toContain("~1234 tokens");
		// World State: L1 contacts in given order with source, plus L2 stale.
		expect(md).toContain("### Files (L1 — most recently contacted first)");
		expect(md).toContain("- b.ts (edit)\n- a.ts (read)");
		expect(md).toContain("### External Changes (L2)");
		expect(md).toContain("- c.ts");
	});

	it("renders the User Verifications section when rulings exist", () => {
		const md = assembleCheckpoint({
			contract: { goal: "g", constraints: [], decisions: [], unresolved: [] },
			executionState: { modelInferences: ["maybe x"] },
			verificationNotes: [],
			userVerified: ["- confirmed fact", "- wrong claim → corrected to: right fact"],
			tokensBefore: 100,
		});
		expect(md).toContain("User Verifications (CONFIRMED by the user");
		expect(md).toContain("- confirmed fact");
		expect(md).toContain("- wrong claim → corrected to: right fact");
		// Section appears before the UNVERIFIED inferences
		expect(md.indexOf("User Verifications")).toBeLessThan(md.indexOf("UNVERIFIED"));
	});

	it("omits the User Verifications section when empty", () => {
		const md = assembleCheckpoint({
			contract: { goal: "g", constraints: [], decisions: [], unresolved: [] },
			executionState: {},
			verificationNotes: [],
			userVerified: [],
			tokensBefore: 100,
		});
		expect(md).not.toContain("User Verifications");
	});

	it("renders '(no recorded world state)' when the file context is empty", () => {
		const md = assembleCheckpoint({
			contract: { goal: "g", constraints: [], decisions: [], unresolved: [] },
			executionState: {},
			fileContext: { files: [], stale: [] },
			verificationNotes: [],
			tokensBefore: 100,
		});
		expect(md).toContain("(no recorded world state)");
		expect(md).not.toContain("### Files (L1");
		expect(md).not.toContain("### External Changes");
	});
});
