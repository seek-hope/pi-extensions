/**
 * recall — retrieve content that compaction removed from the active context.
 *
 * pi's session tree is append-only: compaction changes which entries are sent
 * to the LLM, but never deletes them. recall searches the archived span
 * (everything before the latest checkpoint's kept boundary) by keyword/regex,
 * file path, or exact entry id, and lists past checkpoints.
 */
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const recallSchema = Type.Object({
	query: Type.Optional(
		Type.String({ description: "Keyword or regex to search for in archived entries (case-insensitive)" }),
	),
	files: Type.Optional(
		Type.Array(Type.String(), { description: "Only return entries mentioning one of these paths" }),
	),
	entryId: Type.Optional(Type.String({ description: "Fetch a specific entry by id (with neighbors)" })),
	toolCallId: Type.Optional(
		Type.String({
			description:
				"Directly retrieve the full original output of a pruned tool call by its id (exact id or the 4+ char prefix shown in the prune stub). Works regardless of compaction boundaries.",
		}),
	),
	beforeCount: Type.Optional(Type.Number({ description: "Neighbor entries before entryId (default: 2)" })),
	afterCount: Type.Optional(Type.Number({ description: "Neighbor entries after entryId (default: 2)" })),
	limit: Type.Optional(Type.Number({ description: "Max matches to return (default: 20)" })),
});

const checkpointsSchema = Type.Object({});

interface SerializedEntry {
	id: string;
	type: string;
	timestamp: string;
	text: string;
}

const MAX_TOOL_RESULT_SNIPPET = 2000;

function messageText(msg: unknown): string {
	const content = (msg as { content?: unknown }).content;
	return contentText(content as Parameters<typeof contentText>[0], "");
}

function serializeEntry(entry: SessionEntry): SerializedEntry | undefined {
	const base = { id: entry.id, type: entry.type, timestamp: entry.timestamp };
	if (entry.type === "compaction") {
		return { ...base, text: `[checkpoint]\n${entry.summary}` };
	}
	if (entry.type === "branch_summary") {
		return { ...base, text: `[branch summary]\n${entry.summary}` };
	}
	const messages = sessionEntryToContextMessages(entry);
	if (messages.length === 0) return undefined;
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = messageText(msg).trim();
			if (text) parts.push(`[user] ${text}`);
		} else if (msg.role === "assistant") {
			const text = messageText(msg).trim();
			if (text) parts.push(`[assistant] ${text}`);
			const content = (msg as { content?: Array<{ type: string; name?: string; arguments?: unknown }> }).content;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part.type === "toolCall" && part.name) {
						parts.push(`[tool call] ${part.name}(${JSON.stringify(part.arguments ?? {})})`);
					}
				}
			}
		} else if (msg.role === "toolResult") {
			const toolName = (msg as { toolName?: string }).toolName ?? "tool";
			const text = messageText(msg);
			const snippet =
				text.length > MAX_TOOL_RESULT_SNIPPET ? `${text.substring(0, MAX_TOOL_RESULT_SNIPPET)}…` : text;
			if (snippet.trim()) parts.push(`[tool result: ${toolName}] ${snippet}`);
		} else {
			const text = messageText(msg).trim();
			if (text) parts.push(`[${msg.role}] ${text}`);
		}
	}
	if (parts.length === 0) return undefined;
	return { ...base, text: parts.join("\n") };
}

/** Branch entries that compaction has removed from the active context. */
export function archivedEntries(branch: SessionEntry[]): SessionEntry[] {
	let boundary = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction") {
			const idx = branch.findIndex((e) => e.id === entry.firstKeptEntryId);
			boundary = idx >= 0 ? idx : i + 1;
			break;
		}
	}
	return branch.slice(0, boundary);
}

function matchScore(text: string, matcher: (text: string) => number): number {
	return matcher(text);
}

// Guard user-supplied regexes against pathological backtracing (ReDoS): cap the
// length of the pattern and pre-scan it for classic catastrophic constructs. If a
// pattern looks risky we fall back to a linear substring count, which can never
// hang regardless of the input.
const MAX_REGEX_LENGTH = 120;
// A quantifier immediately followed by another quantifier, or a group that itself
// contains a quantifier and is then quantified — the shapes regex engines cannot
// linearize and that are a common ReDoS trigger.
const ADJACENT_QUANTIFIER = /[+*?]\s*[?+*]/;
const QUANTIFIED_GROUP = /\([^)]*[+*][^)]*\)\s*[+*?]/;

function isRegexSafe(pattern: string): boolean {
	if (pattern.length > MAX_REGEX_LENGTH || pattern.length === 0) return false;
	// Reject the well-known exponential-backtracking shapes. This is a conservative
	// heuristic, not a proof: patterns that pass still run via the regex engine, so a
	// crafted hostile pattern could in principle evade it, but this blocks the common
	// accidental/typical ReDoS patterns with negligible false-positive cost.
	return !ADJACENT_QUANTIFIER.test(pattern) && !QUANTIFIED_GROUP.test(pattern);
}

function makeMatcher(query: string): (text: string) => number {
	let regex: RegExp | undefined;
	if (isRegexSafe(query)) {
		try {
			regex = new RegExp(query, "gi");
		} catch {
			regex = undefined;
		}
	}
	if (regex) {
		return (text: string) => {
			const matches = text.match(regex!);
			return matches ? matches.length : 0;
		};
	}
	const needle = query.toLowerCase();
	return (text: string) => {
		const hay = text.toLowerCase();
		let count = 0;
		let idx = hay.indexOf(needle);
		while (idx >= 0) {
			count++;
			idx = hay.indexOf(needle, idx + needle.length);
		}
		return count;
	};
}

function createRecallTool(): ToolDefinition<typeof recallSchema> {
	const definition: ToolDefinition<typeof recallSchema> = {
		name: "recall",
		label: "Recall",
		description:
			"Retrieve content that compaction removed from the active context. " +
			"The session archive is never deleted — search it by keyword/regex, file path, or exact entry id. " +
			"For a pruned tool output, pass toolCallId (the short id in the prune stub) to get the full original output directly. " +
			"Use recall_checkpoints to list past checkpoints.",
		promptSnippet: "Retrieve pre-compaction content from the session archive (keyword/path/entry-id search).",
		promptGuidelines: [
			"Use recall when the checkpoint says something was decided/discussed but you need the original detail.",
			"recall's query/entryId search covers archived entries; for pruned tool outputs use toolCallId — it returns the full original directly, even before any compaction.",
		],
		parameters: recallSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const branch = ctx.sessionManager.getBranch();

			// Direct retrieval of a tool output by its call id (exact or 4+ char
			// prefix). The session store keeps full originals on the whole branch,
			// so this works for pruned outputs regardless of compaction boundaries.
			if (params.toolCallId) {
				const needle = params.toolCallId;
				const matches: Array<{ entryId: string; toolCallId: string; toolName: string; text: string }> = [];
				for (const entry of branch) {
					if (entry.type !== "message") continue;
					const msg = entry.message as { role?: string; toolCallId?: string; toolName?: string };
					if (msg.role !== "toolResult" || !msg.toolCallId) continue;
					if (msg.toolCallId === needle || (needle.length >= 4 && msg.toolCallId.startsWith(needle))) {
						matches.push({
							entryId: entry.id,
							toolCallId: msg.toolCallId,
							toolName: msg.toolName ?? "tool",
							text: messageText(entry.message),
						});
					}
				}
				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: `No tool result found with toolCallId "${needle}".` }],
						details: {},
						isError: true,
					};
				}
				if (matches.length > 1) {
					return {
						content: [
							{
								type: "text",
								text: `toolCallId prefix "${needle}" is ambiguous — use a longer prefix: ${matches.map((m) => m.toolCallId).join(", ")}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				const match = matches[0]!;
				return {
					content: [
						{
							type: "text",
							text: `Full output of ${match.toolName} call ${match.toolCallId} (entry ${match.entryId}):\n\n${match.text}`,
						},
					],
					details: { toolCallId: match.toolCallId, entryId: match.entryId },
				};
			}

			const archived = archivedEntries(branch);
			if (archived.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Nothing archived yet — the full session history is still in your active context (no compaction has removed anything).",
						},
					],
					details: { archivedCount: 0 },
				};
			}

			// entryId lookup with neighbors
			if (params.entryId) {
				const entryId = params.entryId;
				const idx = archived.findIndex((e) => e.id === entryId || e.id.startsWith(entryId));
				if (idx === -1) {
					return {
						content: [
							{
								type: "text",
								text: `Entry ${params.entryId} not found in the archive (${archived.length} entries).`,
							},
						],
						details: {},
						isError: true,
					};
				}
				const before = Math.max(0, params.beforeCount ?? 2);
				const after = Math.max(0, params.afterCount ?? 2);
				const from = Math.max(0, idx - before);
				const to = Math.min(archived.length - 1, idx + after);
				const parts: string[] = [];
				for (let i = from; i <= to; i++) {
					const serialized = serializeEntry(archived[i]);
					if (serialized) {
						parts.push(
							`── entry ${serialized.id} [${serialized.type}] ${serialized.timestamp}\n${serialized.text}`,
						);
					}
				}
				return { content: [{ type: "text", text: parts.join("\n\n") }], details: { entryId: params.entryId } };
			}

			// Search by query and/or files
			const queries: Array<{ label: string; matcher: (text: string) => number }> = [];
			if (params.query) queries.push({ label: params.query, matcher: makeMatcher(params.query) });
			for (const file of params.files ?? []) {
				queries.push({ label: file, matcher: makeMatcher(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
			}
			if (queries.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Provide query, files, entryId, or toolCallId. Use recall_checkpoints to list past checkpoints.",
						},
					],
					details: {},
					isError: true,
				};
			}

			const limit = params.limit ?? 20;
			const matches: Array<{ serialized: SerializedEntry; score: number }> = [];
			for (const entry of archived) {
				const serialized = serializeEntry(entry);
				if (!serialized) continue;
				let score = 0;
				for (const q of queries) {
					const s = matchScore(serialized.text, q.matcher);
					if (s === 0) {
						score = 0;
						break;
					}
					score += s;
				}
				if (score > 0) matches.push({ serialized, score });
			}
			matches.sort((a, b) => b.score - a.score);

			if (matches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No archived entries matched (${archived.length} entries searched).`,
						},
					],
					details: { archivedCount: archived.length },
				};
			}

			const parts: string[] = [
				`${matches.length} archived entrie(s) matched${matches.length > limit ? ` (showing top ${limit})` : ""}:`,
			];
			for (const { serialized } of matches.slice(0, limit)) {
				parts.push(`── entry ${serialized.id} [${serialized.type}] ${serialized.timestamp}\n${serialized.text}`);
			}
			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { matchCount: matches.length, archivedCount: archived.length },
			};
		},
	};
	return definition;
}

function createRecallCheckpointsTool(): ToolDefinition<typeof checkpointsSchema> {
	const definition: ToolDefinition<typeof checkpointsSchema> = {
		name: "recall_checkpoints",
		label: "Recall Checkpoints",
		description: "List past compaction checkpoints (summaries of archived conversation spans).",
		parameters: checkpointsSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const branch = ctx.sessionManager.getBranch();
			const checkpoints = branch.filter((e) => e.type === "compaction");
			if (checkpoints.length === 0) {
				return { content: [{ type: "text", text: "No checkpoints yet." }], details: {} };
			}
			const parts: string[] = [];
			for (const entry of checkpoints) {
				if (entry.type !== "compaction") continue;
				const version = (entry.details as { version?: number } | undefined)?.version;
				parts.push(
					`── checkpoint ${entry.id} ${entry.timestamp}${version === 2 ? " (structured)" : ""} ~${entry.tokensBefore} tokens before\n${entry.summary}`,
				);
			}
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: { count: checkpoints.length } };
		},
	};
	return definition;
}

/** Recall tool definitions for the built-in registry. */
export function createRecallToolDefinitions(): ToolDefinition[] {
	return [createRecallTool() as ToolDefinition, createRecallCheckpointsTool() as ToolDefinition];
}
