/**
 * context (pi-ex): context-window stewardship extension.
 *
 * Bundles the fork's context pipeline, migrated from pi-ex core:
 * - prune: bulky old read-only tool outputs become metadata-only stubs
 *   before each LLM call (context event).
 * - recall / recall_checkpoints: archive retrieval tools; pruned outputs are
 *   reachable in full via the toolCallId lookup.
 * - compaction: the fork pipeline (round-based cut, drop-oldest-rounds retry,
 *   full-fidelity serialization, structured checkpoints with contract/ledger/
 *   verifier) replaces the default via session_before_compact.
 * - uncertainty protocol: system-prompt rules, message_end scanning, intent
 *   conflict detection, auto-review (dedup + context review + summary review),
 *   and the pre-compaction settle pass.
 * - file context: L1/L2 contact tracking fed by tool results, refreshed into
 *   the checkpoint's World State section.
 */
import { contentText } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	computeFileLists,
	getForkHost,
	getLatestCompactionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { FileContextTracker } from "../shared/file-context.ts";
import { type AutoReviewCandidate, parseConflictIds, runAutoReview, type UserOverrideProposal } from "./lib/auto-review.ts";
import { compactStructured } from "./lib/checkpoint.ts";
import { runContentDedup } from "./lib/content-dedup.ts";
import { compact, type CompactionDetails, prepareCompaction } from "./lib/pipeline.ts";
import { DEFAULT_PRUNE_SETTINGS, pruneContextMessages, type PruneSettings } from "./lib/prune.ts";
import { createRecallToolDefinitions } from "./lib/recall.ts";
import { autoReviewSummaryItems } from "./lib/summary-review.ts";
import { UNCERTAINTY_PROTOCOL_PROMPT, UncertaintyStore } from "./lib/uncertainty.ts";

// ── per-session state ────────────────────────────────────────────────────────

interface SessionState {
	uncertainty: UncertaintyStore;
	fileTracker: FileContextTracker;
	reviewInFlight: boolean;
	conflictCheckInFlight: boolean;
	overridePending: boolean;
}

const sessions = new WeakMap<ExtensionContext["sessionManager"], SessionState>();

function stateFor(ctx: ExtensionContext): SessionState {
	const sm = ctx.sessionManager;
	let s = sessions.get(sm);
	if (!s) {
		s = {
			uncertainty: new UncertaintyStore(sm as SessionManager),
			fileTracker: new FileContextTracker(),
			reviewInFlight: false,
			conflictCheckInFlight: false,
			overridePending: false,
		};
		sessions.set(sm, s);
	}
	return s;
}

function recentConversationText(ctx: ExtensionContext, maxMessages = 20): string {
	const branch = ctx.sessionManager.getBranch();
	const texts: string[] = [];
	for (const entry of branch.slice(-maxMessages * 2)) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = contentText((message as unknown as { content?: never }).content ?? [], "").trim();
			if (text) texts.push(`${message.role}: ${text.slice(0, 600)}`);
		}
	}
	return texts.slice(-maxMessages).join("\n");
}

async function requestAuth(ctx: ExtensionContext, model: Model<any>) {
	const host = getForkHost(ctx.sessionManager);
	try {
		const result = await host?.modelRuntime.getAuth(model);
		if (!result) return { model, apiKey: undefined, headers: undefined, env: undefined };
		const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
		return { model: requestModel, apiKey: result.auth.apiKey, headers: result.auth.headers as Record<string, string> | undefined, env: undefined };
	} catch {
		return { model, apiKey: undefined, headers: undefined, env: undefined };
	}
}

/** Auto-review settle pass (dedup + context review), silent on failure. */
async function runAutoReviewSettle(ctx: ExtensionContext, conflictIds?: string[]): Promise<void> {
	const host = getForkHost(ctx.sessionManager);
	const settings = host?.settingsManager;
	if (!settings?.getUncertaintyReviewAuto()) return;
	const model = ctx.model;
	if (!model) return;
	const s = stateFor(ctx);
	if (s.reviewInFlight) return;

	const store = s.uncertainty;
	const candidates: AutoReviewCandidate[] = [];
	if (conflictIds) {
		const byId = new Map(store.pending().map((f) => [f.id, f] as const));
		for (const id of conflictIds) {
			const flag = byId.get(id);
			if (flag) candidates.push({ id: flag.id, type: flag.type, claim: flag.claim, subject: flag.subject });
		}
	} else {
		for (const flag of store.pending().slice(-10)) {
			candidates.push({ id: flag.id, type: flag.type, claim: flag.claim, subject: flag.subject });
		}
	}
	if (candidates.length === 0) return;

	s.reviewInFlight = true;
	try {
		const auth = await requestAuth(ctx, model);
		const streamFn = host?.streamFn;
		const retry = settings.getRetrySettings();
		if (!conflictIds) {
			await runContentDedup(store, {
				model,
				streamFn,
				retry,
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: AbortSignal.timeout(120_000),
				onUserOverrideProposal: (proposal) => confirmOverride(ctx, s, proposal),
			});
		}
		const remaining = conflictIds
			? candidates
			: store.pending().slice(-10).map((f) => ({ id: f.id, type: f.type, claim: f.claim, subject: f.subject }));
		if (remaining.length === 0) return;
		await runAutoReview(store, {
			model,
			streamFn,
			retry,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			contextText: recentConversationText(ctx),
			signal: AbortSignal.timeout(120_000),
			candidates: remaining,
			onUserOverrideProposal: (proposal) => confirmOverride(ctx, s, proposal),
		});
	} catch {
		// Silent: a failed review must never break compaction or the turn.
	} finally {
		s.reviewInFlight = false;
	}
}

/** User-override confirmation: dialog with a 5-minute auto-decline. */
async function confirmOverride(
	ctx: ExtensionContext,
	s: SessionState,
	proposal: UserOverrideProposal,
): Promise<boolean> {
	if (s.overridePending || !ctx.hasUI) return false;
	s.overridePending = true;
	try {
		const result = await Promise.race([
			ctx.ui.confirm(
				"Uncertainty override",
				`The auto-review wants to override your earlier ruling:\n[${proposal.flagId}] ${proposal.claim}\n→ ${proposal.decision}${proposal.correction ? `: ${proposal.correction}` : ""}\n\nAccept the override?`,
			),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 300_000)),
		]);
		return result === true;
	} catch {
		return false;
	} finally {
		s.overridePending = false;
	}
}

// ── extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── prune ──
	pi.on("context", (event, ctx) => {
		const host = getForkHost(ctx.sessionManager);
		const settings: PruneSettings = host?.settingsManager.getPruneSettings() ?? DEFAULT_PRUNE_SETTINGS;
		const { messages, prunedCount } = pruneContextMessages(event.messages, settings);
		if (prunedCount === 0) return;
		return { messages };
	});

	// ── recall tools (recall.enabled enforced per-execute) ──
	for (const definition of createRecallToolDefinitions()) {
		const originalExecute = definition.execute;
		definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
			const host = getForkHost(ctx.sessionManager);
			if (host && !host.settingsManager.getRecallEnabled()) {
				return {
					content: [{ type: "text", text: "recall is disabled (recall.enabled = false)" }],
					details: {},
					isError: true,
				};
			}
			return originalExecute(toolCallId, params, signal, onUpdate, ctx);
		};
		pi.registerTool(definition);
	}

	// ── uncertainty protocol prompt (chained per turn) ──
	pi.on("before_agent_start", (event) => {
		return { systemPrompt: event.systemPrompt + "\n\n" + UNCERTAINTY_PROTOCOL_PROMPT };
	});

	// ── uncertainty scanning + conflict detection ──
	pi.on("message_end", (event, ctx) => {
		const s = stateFor(ctx);
		const message = event.message;
		if (message.role === "assistant") {
			try {
				s.uncertainty.scanAssistantText(
					contentText((message as unknown as { content?: never }).content ?? [], ""),
					ctx.sessionManager.getLeafId() ?? "",
				);
			} catch {
				// scanning must never break the turn
			}
		}
	});

	pi.on("input", (event, ctx) => {
		const s = stateFor(ctx);
		const text = event.text ?? "";
		if (!text || s.conflictCheckInFlight) return;
		const pending = s.uncertainty.pending();
		if (pending.length === 0) return;
		const ids = parseConflictIds(text);
		if (ids.length === 0) return;
		s.conflictCheckInFlight = true;
		void runAutoReviewSettle(ctx, ids).finally(() => {
			s.conflictCheckInFlight = false;
		});
	});

	// ── file tracking + uncertainty path marks from tool results ──
	pi.on("tool_result", async (event, ctx) => {
		const s = stateFor(ctx);
		const input = (event as { input?: Record<string, unknown> }).input ?? {};
		const p = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
		if (!p) return;
		try {
			const { stat } = await import("node:fs/promises");
			const mtime = await stat(p).then((st) => st.mtimeMs).catch(() => undefined);
			if (event.toolName === "read") {
				const text = contentText((event as unknown as { content?: never }).content ?? [], "");
				s.fileTracker.markRead(p, text, mtime);
			} else if (event.toolName === "write") {
				const content = typeof input.content === "string" ? input.content : "";
				s.fileTracker.markWritten(p, content, mtime);
				s.uncertainty.markPathModified(p);
			} else if (event.toolName === "edit") {
				s.fileTracker.markEdited(p, "", mtime);
				s.uncertainty.markPathModified(p);
			}
		} catch {
			// tracking must never break the turn
		}
	});

	// ── file-state: staleness veto + prompt-time delta notices ──
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const input = event.input as { path?: string; file_path?: string };
		const p = input.path ?? input.file_path;
		if (!p) return;
		const s = stateFor(ctx);
		try {
			const { readFile } = await import("node:fs/promises");
			const diskContent = await readFile(p, "utf-8");
			if (s.fileTracker.check(p, diskContent) === "outdated") {
				const shortPath = p.includes("/") ? p.split("/").slice(-2).join("/") : p;
				return {
					block: true,
					reason:
						`[${event.toolName}] Your context for ${shortPath} is outdated. ` +
						`The file changed since you last read or edited it. ` +
						`Use read() to get the current content, then retry the ${event.toolName}.`,
				};
			}
		} catch {
			// ENOENT: fresh write is fine; other errors must not block
		}
	});

	pi.on("input", async (_event, ctx) => {
		// Delta notice for files the model has seen that changed on disk.
		const s = stateFor(ctx);
		try {
			// One-shot L1 recheck (stat + hash) so external changes are seen.
			await s.fileTracker.refreshContacts();
			const notices = s.fileTracker.staleNotices();
			if (notices.length === 0) return;
			const lines = notices
				.map((notice) => `- ${notice.path} (changed ${new Date(notice.detectedAt).toISOString().slice(11, 19)})`)
				.join("\n");
			const warning =
				`[file-state] ${notices.length === 1 ? "1 file you have seen" : `${notices.length} files you have seen`} changed on disk since your last read:\n` +
				`${lines}\n` +
				`Re-read them before relying on their contents (they may differ from what you remember).`;
			pi.sendUserMessage(warning, { deliverAs: "steer" });
			s.fileTracker.markNotified(notices.map((notice) => notice.path));
		} catch {
			// non-critical
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		// Idle: refresh L1 contact state so the next input's notice is fresh.
		void stateFor(ctx).fileTracker.refreshContacts().catch(() => {});
	});

	// ── compaction pipeline ──
	pi.on("session_before_compact", async (event, ctx) => {
		const host = getForkHost(ctx.sessionManager);
		const settings = host?.settingsManager;
		const model = ctx.model;
		if (!model) return; // no model: let the core default path report it

		const s = stateFor(ctx);

		// Settle pending uncertainty flags first, so the verify pass sees rulings.
		await runAutoReviewSettle(ctx);

		const compactionSettings = settings?.getCompactionSettings() ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentRounds: 2,
			thresholdRatio: 0.9,
		};
		const preparation = prepareCompaction(event.branchEntries, compactionSettings);
		if (!preparation) return; // nothing to compact — core reports it

		const auth = await requestAuth(ctx, model);
		const requestModel = auth.model;
		const streamFn = host?.streamFn;
		const retry = settings?.getRetrySettings();

		let result;
		const quality = settings?.getCompactionQuality() ?? "structured";
		if (quality === "structured" && event.reason !== "overflow") {
			try {
				const keptMessages = [];
				const branch = ctx.sessionManager.getBranch();
				const keptIdx = branch.findIndex((e) => e.id === preparation.firstKeptEntryId);
				if (keptIdx >= 0) {
					for (let i = keptIdx; i < branch.length; i++) {
						keptMessages.push(...sessionEntryToContextMessages(branch[i]));
					}
				}
				await s.fileTracker.refreshContacts();
				const prev = getLatestCompactionEntry(branch);
				const prevDetails = prev?.details as CompactionDetails | undefined;
				const structured = await compactStructured(
					preparation,
					{ contract: prevDetails?.contract, ledger: prevDetails?.ledger },
					requestModel,
					event.customInstructions,
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						signal: event.signal,
						thinkingLevel: ctx.thinkingLevel,
						streamFn,
						retry,
					},
					keptMessages,
					{
						verifyPassText: s.uncertainty.formatForVerifyPass(),
						verifiedLines: s.uncertainty.verifiedSectionLines(),
					},
					s.fileTracker.snapshot(),
				);
				result = {
					summary: structured.summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: structured.usage,
					details: {
						...computeFileLists(preparation.fileOps),
						contract: structured.contract,
						ledger: structured.ledger,
						version: 2,
					},
				};
			} catch (err) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Structured checkpoint failed, falling back to standard compaction: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			}
		}
		if (!result) {
			result = await compact(
				preparation,
				requestModel,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				event.signal,
				ctx.thinkingLevel,
				streamFn,
				auth.env,
				retry,
			);
		}

		// Auto-review the summary's uncertain sections before it becomes permanent.
		let summary = result.summary;
		if (settings?.getUncertaintyReviewAuto()) {
			try {
				summary = await autoReviewSummaryItems(summary, {
					model: requestModel,
					streamFn,
					retry,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					contextText: recentConversationText(ctx),
					signal: AbortSignal.timeout(120_000),
				});
			} catch {
				// keep the unreviewed summary
			}
		}

		return {
			compaction: {
				summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
				usage: result.usage,
				details: result.details,
			},
		};
	});
}
