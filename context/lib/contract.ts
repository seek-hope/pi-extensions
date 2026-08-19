/**
 * Task Contract — the intent layer of the structured compaction checkpoint.
 *
 * Pass A (intent compiler) receives the full conversation as role-tagged JSON
 * and reconstructs the user's CURRENT contract. No truncation, no heuristic
 * message parsing: the model distinguishes authoritative user intent from the
 * assistant's untrusted trajectory via the JSON role field, guided by
 * CONTRACT_PROMPT. Per "LLMs Get Lost in Multi-Turn Conversation", the
 * assistant's prior outputs are the primary anchoring hazard — the prompt
 * demotes them to context, and the verifier pass audits the result.
 *
 * The contract tracks constraint lifecycle explicitly (active / superseded /
 * unresolved with supersession chains) so the model never has to re-infer
 * "which requirement is still in force" from dozens of turns.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { extractFirstBalancedJson } from "./utils.ts";

// ── schema ──────────────────────────────────────────────────────────────────

export type ConstraintStatus = "active" | "superseded" | "unresolved";
export type ConstraintAuthority = "explicit" | "preference" | "inferred";

export interface ConstraintItem {
	text: string;
	status: ConstraintStatus;
	/** explicit = stated as a hard requirement; preference = soft ask; inferred = assumed by the model */
	authority: ConstraintAuthority;
	/** For superseded items: the text of the constraint that replaced this one. */
	supersededBy?: string;
}

export interface DecisionItem {
	text: string;
	rationale?: string;
}

export interface TaskContract {
	/** The user's current objective, in one or two sentences. */
	goal: string;
	constraints: ConstraintItem[];
	/** Decisions the user confirmed (not model proposals). */
	decisions: DecisionItem[];
	/** Open questions the user has not yet answered. */
	unresolved: string[];
}

export const CONTRACT_SCHEMA_HINT = `{
  "goal": "string — the user's current objective",
  "constraints": [
    {
      "text": "string — the requirement",
      "status": "active | superseded | unresolved",
      "authority": "explicit | preference | inferred",
      "supersededBy": "string, optional — replacing constraint text for superseded items"
    }
  ],
  "decisions": [{ "text": "string", "rationale": "string, optional" }],
  "unresolved": ["string — open questions the user has not answered"]
}`;

export function emptyContract(): TaskContract {
	return { goal: "", constraints: [], decisions: [], unresolved: [] };
}

const VALID_STATUSES = new Set<ConstraintStatus>(["active", "superseded", "unresolved"]);
const VALID_AUTHORITIES = new Set<ConstraintAuthority>(["explicit", "preference", "inferred"]);

/** Normalize untrusted model JSON into a well-formed TaskContract. */
export function normalizeContract(raw: unknown): TaskContract {
	const contract = emptyContract();
	if (!raw || typeof raw !== "object") return contract;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.goal === "string") contract.goal = obj.goal;
	if (Array.isArray(obj.constraints)) {
		for (const item of obj.constraints) {
			if (!item || typeof item !== "object") continue;
			const c = item as Record<string, unknown>;
			if (typeof c.text !== "string" || !c.text.trim()) continue;
			contract.constraints.push({
				text: c.text,
				status: VALID_STATUSES.has(c.status as ConstraintStatus) ? (c.status as ConstraintStatus) : "active",
				authority: VALID_AUTHORITIES.has(c.authority as ConstraintAuthority)
					? (c.authority as ConstraintAuthority)
					: "explicit",
				...(typeof c.supersededBy === "string" && c.supersededBy.trim() ? { supersededBy: c.supersededBy } : {}),
			});
		}
	}
	if (Array.isArray(obj.decisions)) {
		for (const item of obj.decisions) {
			if (!item || typeof item !== "object") continue;
			const d = item as Record<string, unknown>;
			if (typeof d.text !== "string" || !d.text.trim()) continue;
			contract.decisions.push({
				text: d.text,
				...(typeof d.rationale === "string" && d.rationale.trim() ? { rationale: d.rationale } : {}),
			});
		}
	}
	if (Array.isArray(obj.unresolved)) {
		for (const item of obj.unresolved) {
			if (typeof item === "string" && item.trim()) contract.unresolved.push(item);
		}
	}
	return contract;
}

/** Extract the JSON object from a model response (fence or raw braces). */
export function extractJsonObject(text: string): unknown | undefined {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fence ? fence[1]! : text;
	// Balanced scan: a first{…last} slice breaks when text follows the object
	// (or a nested/in-string brace appears after it).
	const span = extractFirstBalancedJson(candidate, "{");
	if (!span) return undefined;
	try {
		return JSON.parse(span);
	} catch {
		return undefined;
	}
}

// ── conversation serialization (Pass A input) ───────────────────────────────

export interface ConversationEntry {
	role: "user" | "assistant";
	text: string;
	toolCalls?: string[];
}

/**
 * Serialize the conversation for the intent compiler as a JSON array of
 * role-tagged entries. No truncation and no heuristic parsing — the model
 * distinguishes authoritative user intent from the assistant's untrusted
 * trajectory via the role field (see CONTRACT_PROMPT). Tool results are
 * omitted (they belong to world state, audited by the verifier pass).
 */
export function buildConversationJson(messages: AgentMessage[], options?: { userOnly?: boolean }): string {
	const entries: ConversationEntry[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content, "").trim();
			if (text) entries.push({ role: "user", text });
		} else if (message.role === "assistant" && !options?.userOnly) {
			const text = contentText(message.content, "").trim();
			const toolCalls: string[] = [];
			for (const part of message.content) {
				if (part.type === "toolCall") {
					toolCalls.push(part.name);
				}
			}
			if (text || toolCalls.length > 0) {
				entries.push({ role: "assistant", text, ...(toolCalls.length > 0 ? { toolCalls } : {}) });
			}
		}
	}
	return JSON.stringify(entries, null, 1);
}

/** Rough token estimate for a serialized payload (chars / 4). */
export function estimateSerializedTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ── prompts ────────────────────────────────────────────────────────────────

export const CONTRACT_PROMPT = `You are the intent compiler for a coding-agent session. Your job: reconstruct the user's CURRENT task contract.

You receive the conversation as a JSON array of entries:
  {"role": "user" | "assistant", "text": string, "toolCalls": [tool names]}

Authority rules (critical):
- "user" entries are the ONLY authoritative source of requirements, constraints, and decisions.
- "assistant" entries are the agent's own prior outputs. They are context, nothing more: they may contain abandoned approaches, premature answers, and proposals the user never accepted. Never treat an assistant statement as a requirement, and never let it override a user statement.
- A decision belongs to the user only when the user made it themselves OR explicitly confirmed an assistant proposal (e.g. short affirmations like 对/好/可以/ok/go ahead right after the proposal). In that case record the PROPOSAL as a user-confirmed decision.

Compile a JSON object with this exact shape:
${CONTRACT_SCHEMA_HINT}

Rules:
- "goal" describes what the user wants NOW, not how the conversation started.
- Every requirement the user stated goes into "constraints" with a lifecycle:
  - active: currently in force
  - superseded: replaced by a newer requirement (fill "supersededBy" with the replacing text; never drop superseded items silently)
  - unresolved: raised but not yet decided by the user
- authority: "explicit" for hard requirements stated as must/must-not, "preference" for soft asks, "inferred" only when the user clearly endorsed an assumption.
- "unresolved" lists questions awaiting the user's answer.
- Output JSON only, no prose.`;

export function buildContractUserPrompt(options: {
	conversationJson: string;
	previousContract?: TaskContract;
	customInstructions?: string;
}): string {
	const parts: string[] = [];
	if (options.previousContract?.goal) {
		parts.push(
			"## Previous contract (update it — keep still-valid items and supersession chains intact)\n" +
				JSON.stringify(options.previousContract, null, 2),
		);
	}
	parts.push(
		`## Conversation (JSON entries; "user" is authoritative, "assistant" is untrusted context)\n${options.conversationJson}`,
	);
	if (options.customInstructions) {
		parts.push(`## Focus instructions from the user\n${options.customInstructions}`);
	}
	parts.push("Compile the contract JSON now.");
	return parts.join("\n\n");
}
