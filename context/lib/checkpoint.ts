/**
 * Structured checkpoint — the compaction pipeline v2.
 *
 * Replaces the single narrative summary with a four-layer artifact:
 *   Task Contract (LLM pass A, user-view only — anti-anchoring)
 *   World State (deterministic Action Ledger + cumulative file tracking)
 *   Execution State + corrections (LLM pass C, verifier against transcript)
 *   Verification Notes (audit trail of contract corrections)
 *
 * On any failure the caller falls back to the standard single-summary path.
 */
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, type RetryPolicy, type Usage } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { FileContextSnapshot } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { completeSummarization } from "@earendil-works/pi-coding-agent";
import {
	buildContractUserPrompt,
	buildConversationJson,
	CONTRACT_PROMPT,
	type ConstraintItem,
	estimateSerializedTokens,
	extractJsonObject,
	normalizeContract,
	type TaskContract,
} from "./contract.ts";
import type { CompactionPreparation } from "./pipeline.ts";
import { combineUsage } from "./pipeline.ts";
import { serializeConversation } from "./utils.ts";
import { type ActionLedger, extractLedgerActions, renderLedger } from "./ledger.ts";

// ── execution state ─────────────────────────────────────────────────────────

export interface ExternalStateItem {
	property: string;
	value: string;
	source?: string;
	refresh?: string;
}

export interface ExecutionState {
	currentApproach?: string;
	done?: string[];
	inProgress?: string[];
	blocked?: string[];
	nextSteps?: string[];
	modelInferences?: string[];
	externalState?: ExternalStateItem[];
}

function stringArray(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export function normalizeExecutionState(raw: unknown): ExecutionState {
	if (!raw || typeof raw !== "object") return {};
	const obj = raw as Record<string, unknown>;
	const state: ExecutionState = {};
	if (typeof obj.currentApproach === "string" && obj.currentApproach.trim())
		state.currentApproach = obj.currentApproach;
	const done = stringArray(obj.done);
	if (done.length) state.done = done;
	const inProgress = stringArray(obj.inProgress);
	if (inProgress.length) state.inProgress = inProgress;
	const blocked = stringArray(obj.blocked);
	if (blocked.length) state.blocked = blocked;
	const nextSteps = stringArray(obj.nextSteps);
	if (nextSteps.length) state.nextSteps = nextSteps;
	const modelInferences = stringArray(obj.modelInferences);
	if (modelInferences.length) state.modelInferences = modelInferences;
	if (Array.isArray(obj.externalState)) {
		const items: ExternalStateItem[] = [];
		for (const item of obj.externalState) {
			if (!item || typeof item !== "object") continue;
			const e = item as Record<string, unknown>;
			if (typeof e.property !== "string" || typeof e.value !== "string") continue;
			items.push({
				property: e.property,
				value: e.value,
				...(typeof e.source === "string" ? { source: e.source } : {}),
				...(typeof e.refresh === "string" ? { refresh: e.refresh } : {}),
			});
		}
		if (items.length) state.externalState = items;
	}
	return state;
}

// ── verifier output ─────────────────────────────────────────────────────────

export interface ContractCorrections {
	missingConstraints: string[];
	revived: string[];
	contradictions: string[];
}

interface VerifyResult {
	corrections: ContractCorrections;
	executionState: ExecutionState;
}

function normalizeCorrections(raw: unknown): ContractCorrections {
	const corrections: ContractCorrections = { missingConstraints: [], revived: [], contradictions: [] };
	if (!raw || typeof raw !== "object") return corrections;
	const obj = raw as Record<string, unknown>;
	corrections.missingConstraints = stringArray(obj.missingConstraints);
	corrections.revived = stringArray(obj.revived);
	corrections.contradictions = stringArray(obj.contradictions);
	return corrections;
}

const VERIFY_SCHEMA_HINT = `{
  "corrections": {
    "missingConstraints": ["user requirements present in the transcript but missing from the contract"],
    "revived": ["contract items marked superseded that are actually still in force"],
    "contradictions": ["contract items that conflict with tool-verified facts from the transcript"]
  },
  "executionState": {
    "currentApproach": "string — the approach currently being executed",
    "done": ["completed work items"],
    "inProgress": ["work currently underway"],
    "blocked": ["blockers, if any"],
    "nextSteps": ["what should happen next, in order"],
    "modelInferences": ["assumptions the assistant made that were never verified — mark them honestly"],
    "externalState": [
      { "property": "string", "value": "string", "source": "string, optional", "refresh": "string, optional — when/how to re-check" }
    ]
  }
}`;

const VERIFY_PROMPT = `You are the verifier for a session checkpoint. You receive a draft Task Contract (compiled from the user's messages only) and the full conversation transcript.

The transcript is in chronological order — its END is the current state of the work. Review it from newest to oldest: the last steps (final tool calls, results, and user messages) determine the Execution State. Never omit the most recent completed steps from the Execution State; a step finished just before this checkpoint must appear in done/inProgress, not disappear.

Two jobs:

A. Audit the contract against the transcript:
   - missingConstraints: requirements the user stated that the contract missed. Quote them faithfully.
   - revived: contract items marked "superseded" that the transcript shows are actually still in force.
   - contradictions: contract statements that conflict with tool-verified facts (test results, file contents, command outputs).
   Only report real findings. Empty arrays are the expected common case.

B. Write the Execution State — a factual snapshot of the work itself (not the user's intent):
   - currentApproach, done, inProgress, blocked, nextSteps.
   - modelInferences: assumptions the assistant made that were never confirmed by the user or by tools. Marking these honestly prevents them from silently becoming "facts".
   - externalState: dynamic observations (server status, versions, prices, remote state) with source and refresh guidance. These may be stale later — never present them as timeless facts.

Output JSON only, in this exact shape:
${VERIFY_SCHEMA_HINT}`;

// ── LLM passes ──────────────────────────────────────────────────────────────

export interface CheckpointAuthOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
}

/** Stream options shared by the checkpoint LLM passes (forwards the reasoning level). */
function checkpointStreamOptions(model: Model<any>, auth: CheckpointAuthOptions): SimpleStreamOptions {
	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal: auth.signal,
	};
	if (model.reasoning && auth.thinkingLevel && auth.thinkingLevel !== "off") {
		options.reasoning = auth.thinkingLevel;
	}
	return options;
}

async function runContractPass(
	messages: AgentMessage[],
	previousContract: TaskContract | undefined,
	model: Model<any>,
	customInstructions: string | undefined,
	tokenBudget: number,
	auth: CheckpointAuthOptions,
): Promise<{ contract: TaskContract; usage?: Usage }> {
	// Full, untruncated conversation JSON. If it exceeds the budget, fall back
	// to user messages only (still complete) — never cut content mid-string.
	let conversationJson = buildConversationJson(messages);
	if (estimateSerializedTokens(conversationJson) > tokenBudget) {
		conversationJson = buildConversationJson(messages, { userOnly: true });
	}
	if (estimateSerializedTokens(conversationJson) > tokenBudget) {
		throw new Error(
			`Conversation too large for the contract pass (~${estimateSerializedTokens(conversationJson)} tok > ${tokenBudget} budget)`,
		);
	}

	const response = await completeSummarization(
		model,
		{
			systemPrompt: CONTRACT_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildContractUserPrompt({ conversationJson, previousContract, customInstructions }),
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		checkpointStreamOptions(model, auth),
		auth.streamFn,
		auth.retry,
	);
	if (response.stopReason === "error") {
		throw new Error(`Contract pass failed: ${response.errorMessage || "unknown error"}`);
	}
	const parsed = extractJsonObject(contentText(response.content, ""));
	if (parsed === undefined) {
		throw new Error("Contract pass returned no parseable JSON");
	}
	return { contract: normalizeContract(parsed), usage: response.usage };
}

async function runVerifyPass(
	contract: TaskContract,
	serializedTranscript: string,
	customInstructions: string | undefined,
	model: Model<any>,
	auth: CheckpointAuthOptions,
	userVerifications?: string,
): Promise<{ result: VerifyResult; usage?: Usage }> {
	const parts = [
		`## Draft Task Contract\n${JSON.stringify(contract, null, 2)}`,
		`## Full transcript (serialized)\n${serializedTranscript}`,
	];
	if (customInstructions) {
		parts.push(`## Focus instructions from the user\n${customInstructions}`);
	}
	if (userVerifications) {
		parts.push(`## User verification rulings (authoritative)\n${userVerifications}`);
	}
	parts.push("Audit the contract and write the execution state JSON now.");

	const response = await completeSummarization(
		model,
		{
			systemPrompt: VERIFY_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: parts.join("\n\n") }], timestamp: Date.now() }],
		},
		checkpointStreamOptions(model, auth),
		auth.streamFn,
		auth.retry,
	);
	if (response.stopReason === "error") {
		throw new Error(`Verify pass failed: ${response.errorMessage || "unknown error"}`);
	}
	const parsed = extractJsonObject(contentText(response.content, ""));
	if (parsed === undefined) {
		throw new Error("Verify pass returned no parseable JSON");
	}
	const obj = parsed as Record<string, unknown>;
	return {
		result: {
			corrections: normalizeCorrections(obj.corrections),
			executionState: normalizeExecutionState(obj.executionState),
		},
		usage: response.usage,
	};
}

// ── correction application ──────────────────────────────────────────────────

export function applyCorrections(contract: TaskContract, corrections: ContractCorrections): string[] {
	const notes: string[] = [];
	for (const text of corrections.missingConstraints) {
		const item: ConstraintItem = { text, status: "active", authority: "explicit" };
		contract.constraints.push(item);
		notes.push(`Added missing constraint: ${text}`);
	}
	for (const text of corrections.revived) {
		const item = contract.constraints.find((c) => c.status === "superseded" && c.text.includes(text));
		if (item) {
			item.status = "active";
			delete item.supersededBy;
			notes.push(`Revived constraint (was superseded): ${item.text}`);
		}
	}
	for (const text of corrections.contradictions) {
		notes.push(`! Contradiction with verified facts: ${text}`);
	}
	return notes;
}

// ── assembly ────────────────────────────────────────────────────────────────

export function assembleCheckpoint(options: {
	contract: TaskContract;
	executionState: ExecutionState;
	ledger?: ActionLedger;
	fileContext?: FileContextSnapshot;
	verificationNotes: string[];
	userVerified?: string[];
	tokensBefore: number;
}): string {
	const { contract, executionState, fileContext } = options;
	const out: string[] = [];

	out.push("# Session Checkpoint");
	out.push(
		"\n_The Task Contract below is the authoritative statement of the user's current requirements. " +
			"Where later conversation or older context conflicts with it, the contract wins._",
	);

	out.push("\n## Task Contract");
	out.push(`\n**Goal:** ${contract.goal || "(unspecified)"}`);
	if (contract.constraints.length > 0) {
		out.push("\n### Constraints");
		for (const c of contract.constraints) {
			const tag =
				c.status === "active" ? `ACTIVE|${c.authority}` : c.status === "superseded" ? "SUPERSEDED" : "UNRESOLVED";
			const suffix = c.supersededBy ? ` → replaced by: ${c.supersededBy}` : "";
			out.push(`- [${tag}] ${c.text}${suffix}`);
		}
	}
	if (contract.decisions.length > 0) {
		out.push("\n### Confirmed Decisions");
		for (const d of contract.decisions) {
			out.push(`- ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`);
		}
	}
	if (contract.unresolved.length > 0) {
		out.push("\n### Open Questions");
		for (const q of contract.unresolved) out.push(`- ${q}`);
	}

	const hasFiles = (fileContext?.files.length ?? 0) > 0 || (fileContext?.stale.length ?? 0) > 0;
	out.push("\n## World State");
	if (fileContext && fileContext.files.length > 0) {
		out.push("\n### Files (L1 — most recently contacted first)");
		for (const f of fileContext.files) {
			out.push(`- ${f.path} (${f.source})`);
		}
	}
	if (fileContext && fileContext.stale.length > 0) {
		out.push("\n### External Changes (L2)");
		for (const path of fileContext.stale) {
			out.push(`- ${path}`);
		}
	}
	if (!hasFiles) {
		out.push("(no recorded world state)");
	}

	if (options.ledger) {
		const ledgerSection = renderLedger(options.ledger);
		if (ledgerSection) {
			out.push("\n## Action Ledger");
			out.push("\n_Deterministic record of world-changing actions (cumulative across compactions).");
			out.push(ledgerSection);
		}
	}

	out.push("\n## Execution State");
	if (executionState.currentApproach) out.push(`\n**Current approach:** ${executionState.currentApproach}`);
	if (executionState.done?.length) {
		out.push("\n### Done");
		for (const d of executionState.done) out.push(`- ${d}`);
	}
	if (executionState.inProgress?.length) {
		out.push("\n### In Progress");
		for (const d of executionState.inProgress) out.push(`- ${d}`);
	}
	if (executionState.blocked?.length) {
		out.push("\n### Blocked");
		for (const d of executionState.blocked) out.push(`- ${d}`);
	}
	if (executionState.nextSteps?.length) {
		out.push("\n### Next Steps");
		executionState.nextSteps.forEach((s, i) => {
			out.push(`${i + 1}. ${s}`);
		});
	}
	if (options.userVerified && options.userVerified.length > 0) {
		out.push("\n### User Verifications (CONFIRMED by the user during the conversation — treat as facts)");
		for (const v of options.userVerified) out.push(v);
	}
	if (executionState.modelInferences?.length) {
		out.push("\n### Model Inferences (UNVERIFIED — treat as assumptions, not facts)");
		for (const m of executionState.modelInferences) out.push(`- ${m}`);
	}
	if (executionState.externalState?.length) {
		out.push("\n### External State (observed values — may be stale)");
		for (const e of executionState.externalState) {
			const meta = [e.source ? `source: ${e.source}` : "", e.refresh ? `refresh: ${e.refresh}` : ""]
				.filter(Boolean)
				.join(", ");
			out.push(`- ${e.property}: ${e.value}${meta ? ` (${meta})` : ""}`);
		}
	}

	if (options.verificationNotes.length > 0) {
		out.push("\n## Verification Notes");
		for (const n of options.verificationNotes) out.push(`- ${n}`);
	}

	out.push(`\n_Context before compaction: ~${options.tokensBefore} tokens._`);
	return out.join("\n");
}

// ── orchestration ───────────────────────────────────────────────────────────

export interface StructuredCompactionResult {
	summary: string;
	contract: TaskContract;
	ledger: ActionLedger;
	usage?: Usage;
}

/**
 * Run the structured checkpoint pipeline over a preparation.
 * Throws on LLM failures — the caller falls back to the standard path.
 */
export async function compactStructured(
	preparation: CompactionPreparation,
	previous: { contract?: TaskContract; ledger?: ActionLedger },
	model: Model<any>,
	customInstructions: string | undefined,
	auth: CheckpointAuthOptions,
	keptMessages?: AgentMessage[],
	userReview?: { verifyPassText?: string; verifiedLines?: string[] },
	fileContext?: FileContextSnapshot,
): Promise<StructuredCompactionResult> {
	const allMessages = [...preparation.messagesToSummarize];

	// Budget for each pass: context window minus the configured reserve and a
	// response allowance. Content is never truncated mid-string — oversized
	// inputs degrade gracefully instead.
	const tokenBudget = Math.max(8_000, model.contextWindow - preparation.settings.reserveTokens - 20_000);

	// Pass A: intent compiler (user-view only, over summarized + kept messages)
	const { contract, usage: usageA } = await runContractPass(
		[...allMessages, ...(keptMessages ?? [])],
		previous.contract,
		model,
		customInstructions,
		tokenBudget,
		auth,
	);

	// Pass B: deterministic ledger (cumulative)
	const ledger = extractLedgerActions(allMessages, previous.ledger);

	// Pass C: verifier (contract + transcript → corrections + execution state).
	// Serialization is full-fidelity (no truncation), so one pass suffices.
	const serialized = serializeConversation(convertToLlm(allMessages));
	if (estimateSerializedTokens(serialized) > tokenBudget) {
		throw new Error(
			`Transcript too large for the verify pass (~${estimateSerializedTokens(serialized)} tok > ${tokenBudget} budget)`,
		);
	}
	const { result: verify, usage: usageC } = await runVerifyPass(
		contract,
		serialized,
		customInstructions,
		model,
		auth,
		userReview?.verifyPassText,
	);
	const verificationNotes = applyCorrections(contract, verify.corrections);

	const summary = assembleCheckpoint({
		contract,
		executionState: verify.executionState,
		ledger,
		fileContext,
		verificationNotes,
		userVerified: userReview?.verifiedLines,
		tokensBefore: preparation.tokensBefore,
	});

	// Both passes ran: sum their usage instead of discarding one.
	const usage = usageA && usageC ? combineUsage(usageA, usageC) : (usageC ?? usageA);
	return { summary, contract, ledger, usage };
}
