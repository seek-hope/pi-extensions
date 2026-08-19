/**
 * TodoStore — session-scoped todo flow state.
 *
 * Semantics ported from the todo extension, upgraded for core integration:
 * - Content is NOT truncated (widget renders full text). ANSI/control
 *   characters are still stripped for terminal safety.
 * - State persists as session custom entries ("todo") written on every
 *   model-owned todo_write; restore reads the latest entry on the branch.
 * - Programmatic items (owned by other core modules, e.g. subagent) survive
 *   model rewrites, auto-clean, and session-tree restores via the bridge
 *   mutation/removal replay design.
 * - Progress items are ephemeral, survive tree restores, never persist.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	id?: string;
	content: string;
	status: TodoStatus;
}

export interface TodoProgressItem {
	status: string;
	content: string;
}

export const TODO_SESSION_ENTRY_TYPE = "todo";

export const STATUS_ICONS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
	cancelled: "✗",
};

function isValidTodoStatus(s: string): s is TodoStatus {
	return (TODO_STATUSES as readonly string[]).includes(s);
}

function normalizeStatus(raw: string | undefined): TodoStatus {
	if (!raw) return "pending";
	const s = String(raw).trim().toLowerCase();
	return isValidTodoStatus(s) ? s : "pending";
}

/**
 * Strip ANSI escape sequences (CSI + SGR) and C0 control characters from
 * content before rendering. Prevents user-supplied escape codes from
 * corrupting widget layout or injecting formatting.
 */
export function sanitizeContent(raw: string): string {
	return raw
		.replace(/\x1b\[[0-9;?>=<:]*[\x20-\x2F]*[@-~]/g, "")
		.replace(/\x1b\[[^\x1b]*/g, "")
		.replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\][^\x1b]*/g, "")
		.replace(/\x1b[PX^_].*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[PX^_][^\x1b]*/g, "")
		.replace(/\x1b[\x20-\x2F]*[\x30-\x5A\x5C-\x7E]/g, "")
		.replace(/[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g, "")
		.replace(/\t/g, " ")
		.replace(/\n/g, " ")
		.replace(/\u2028|\u2029/g, " ")
		.replace(/(\u200C|\u200D)|[\p{Cf}\p{Cs}]/gu, (_m, keep) => keep || "");
}

export interface TodoStoreCallbacks {
	/** Called whenever visible state changed and widgets should re-render. */
	onChange(): void;
	/** Informational notification (e.g. "All tasks complete"). */
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export class TodoStore {
	private items: TodoItem[] = [];
	/** Ephemeral progress items (subagent status lines). Survive tree restores, never persist. */
	private readonly progressItems = new Map<string, TodoProgressItem>();

	private readonly programmaticIds = new Set<string>();
	private readonly bridgeMutations = new Map<string, { content: string; status: TodoStatus }>();
	private readonly bridgeRemovedIds = new Set<string>();
	private readonly pendingBridgeRenames = new Set<string>();
	private bridgeInProgressId: string | null = null;
	private readonly autoCleanedContents = new Set<string>();
	private lastAutoClearNotifyKey: string | null = null;
	private autoClearTimer: ReturnType<typeof setTimeout> | null = null;

	private itemIdCounter = 0;
	private sessionNonce = Date.now().toString(36);

	private readonly sessionManager: SessionManager;
	private readonly callbacks: TodoStoreCallbacks;

	constructor(sessionManager: SessionManager, callbacks: TodoStoreCallbacks) {
		this.sessionManager = sessionManager;
		this.callbacks = callbacks;
	}

	// ── queries ──────────────────────────────────────────────────────────

	/** Items owned by the model (excludes programmatic bridge items). */
	getModelItems(): TodoItem[] {
		return this.items.filter((i) => !this.isProgrammaticItem(i)).map((i) => ({ ...i }));
	}

	getItems(): TodoItem[] {
		return this.items.map((i) => ({ ...i }));
	}

	getProgressItems(): Array<[string, TodoProgressItem]> {
		return Array.from(this.progressItems.entries());
	}

	get isEmpty(): boolean {
		return this.items.length === 0 && this.progressItems.size === 0;
	}

	private isProgrammaticItem(item: TodoItem): boolean {
		return item.id !== undefined && this.programmaticIds.has(item.id);
	}

	// ── shared mutation helpers ──────────────────────────────────────────

	private changed(): void {
		this.callbacks.onChange();
	}

	private cancelAutoClearTimer(): void {
		if (this.autoClearTimer !== null) {
			clearTimeout(this.autoClearTimer);
			this.autoClearTimer = null;
		}
	}

	private mintId(): string {
		return `${this.sessionNonce}_${++this.itemIdCounter}`;
	}

	private advanceCounterPast(id: string): void {
		const n = id.includes("_") ? Number(id.split("_").pop()) : Number(id);
		if (Number.isFinite(n)) this.itemIdCounter = Math.max(this.itemIdCounter, n);
	}

	private recordBridgeMutation(item: TodoItem): void {
		if (item.id !== undefined && !this.isProgrammaticItem(item)) {
			const prev = this.bridgeMutations.get(item.id);
			const content = prev && this.pendingBridgeRenames.has(item.id) ? prev.content : item.content;
			this.bridgeMutations.set(item.id, { content, status: item.status });
		}
	}

	/** Refresh already-tracked bridge mutations from live state. Does not start tracking new items. */
	private syncBridgeMutations(): void {
		for (const item of this.items) {
			if (item.id !== undefined && this.bridgeMutations.has(item.id)) {
				const prev = this.bridgeMutations.get(item.id)!;
				const content = this.pendingBridgeRenames.has(item.id) ? prev.content : item.content;
				this.bridgeMutations.set(item.id, { content, status: item.status });
			}
		}
	}

	/**
	 * Enforce the "only one in_progress" rule by demoting all but the preferred
	 * item. When preferredIdx is provided and valid, that item is kept;
	 * otherwise the last in_progress item by index is kept.
	 */
	private enforceOneInProgress(preferredIdx?: number): void {
		const inProgressIndices: number[] = [];
		for (let i = 0; i < this.items.length; i++) {
			if (this.items[i].status === "in_progress") inProgressIndices.push(i);
		}
		if (inProgressIndices.length <= 1) return;
		let keepIdx = inProgressIndices[inProgressIndices.length - 1];
		if (
			preferredIdx !== undefined &&
			preferredIdx >= 0 &&
			preferredIdx < this.items.length &&
			this.items[preferredIdx].status === "in_progress"
		) {
			keepIdx = preferredIdx;
		}
		for (const idx of inProgressIndices) {
			if (idx !== keepIdx) this.items[idx].status = "pending";
		}
	}

	private pruneAutoCleanedContents(): void {
		const liveContents = new Set(this.items.map((i) => i.content));
		for (const content of this.autoCleanedContents) {
			if (!liveContents.has(content)) this.autoCleanedContents.delete(content);
		}
	}

	/** If all model-owned items are done, notify and schedule an auto-clear wipe. */
	private checkAndAutoClear(): void {
		const modelItems = this.items.filter((i) => !this.isProgrammaticItem(i));
		const allDone =
			modelItems.length > 0 && modelItems.every((i) => i.status === "completed" || i.status === "cancelled");
		if (!allDone) {
			this.lastAutoClearNotifyKey = null;
			this.cancelAutoClearTimer();
			return;
		}
		const doneKey = modelItems
			.map((i) => `${i.status}:${i.content}`)
			.sort()
			.join("\n");
		if (doneKey !== this.lastAutoClearNotifyKey) {
			this.lastAutoClearNotifyKey = doneKey;
			const doneList = modelItems.map((i) => `  ${STATUS_ICONS[i.status]} ${i.content}`).join("\n");
			this.callbacks.notify(`All tasks complete:\n${doneList}`, "info");
			for (const i of this.items) {
				if (!this.isProgrammaticItem(i)) this.autoCleanedContents.add(i.content);
			}
		}
		this.cancelAutoClearTimer();
		this.autoClearTimer = setTimeout(() => {
			this.autoClearTimer = null;
			const wiped = this.items.filter((i) => !this.isProgrammaticItem(i));
			this.items = this.items.filter((i) => this.isProgrammaticItem(i));
			const remaining = this.items.filter((i) => !this.isProgrammaticItem(i));
			this.lastAutoClearNotifyKey =
				remaining.length > 0 && remaining.every((i) => i.status === "completed" || i.status === "cancelled")
					? remaining
							.map((i) => `${i.status}:${i.content}`)
							.sort()
							.join("\n")
					: null;
			this.pruneAutoCleanedContents();
			for (const i of wiped) {
				this.autoCleanedContents.add(i.content);
				if (i.id !== undefined) this.bridgeRemovedIds.add(i.id);
			}
			this.changed();
		}, 2000);
	}

	// ── model entry point (todo_write tool) ─────────────────────────────

	/**
	 * Replace the model-owned list with the model's authoritative snapshot.
	 * Programmatic (bridge-owned) items are preserved and merged back.
	 * Returns warnings generated during validation.
	 */
	replaceFromModel(rawItems: Array<{ content: string; status?: string }>): {
		items: TodoItem[];
		warnings: string[];
	} {
		const warnings: string[] = [];

		const totalProvided = rawItems.length;
		if (totalProvided > 100) {
			warnings.push(`List capped at 100 items (${totalProvided} provided). The first 100 items were kept.`);
		}
		const slice = rawItems.slice(0, 100);

		let items: TodoItem[] = slice.map((item, i) => {
			if (!item || typeof item !== "object") throw new Error(`Todo item ${i + 1} is not an object`);
			const content = (item.content || "").trim();
			const sanitized = sanitizeContent(content);
			if (!sanitized) throw new Error(`Todo item ${i + 1} has empty content after sanitization.`);

			let status: TodoStatus = "pending";
			if (item.status) {
				const s = String(item.status).trim().toLowerCase();
				if (isValidTodoStatus(s)) {
					status = s;
				} else {
					warnings.push(`Item ${i + 1}: invalid status "${item.status}" → defaulting to "pending"`);
				}
			}
			return { id: this.mintId(), content: sanitized, status };
		});

		// Dedup by content, keeping the first occurrence.
		const seen = new Set<string>();
		items = items.filter((item) => {
			if (seen.has(item.content)) {
				warnings.push(`Duplicate item: "${item.content}" — keeping only first occurrence.`);
				return false;
			}
			seen.add(item.content);
			return true;
		});

		// Auto-fix multiple in_progress: keep the last one.
		const inProgress = items.filter((i) => i.status === "in_progress");
		if (inProgress.length > 1) {
			const lastInProgressIdx = items.reduce((last, item, idx) => (item.status === "in_progress" ? idx : last), -1);
			let demoted = 0;
			for (let i = 0; i < items.length; i++) {
				if (items[i].status === "in_progress" && i !== lastInProgressIdx) {
					items[i].status = "pending";
					demoted++;
				}
			}
			warnings.push(`Auto-fixed: demoted ${demoted} extra in_progress item(s) → pending (only one allowed).`);
		}

		// Preserve programmatic items the model didn't include. On content-twin
		// collision, replace the model-owned twin so the programmatic id survives.
		const programmaticItems = this.items.filter((i) => this.isProgrammaticItem(i));
		this.items = items;
		for (const prog of programmaticItems) {
			const twinIdx = this.items.findIndex((i) => i.content === prog.content);
			if (twinIdx === -1) {
				this.items.push(prog);
			} else {
				this.items[twinIdx] = prog;
			}
		}

		// Re-enforce after re-adding programmatic items; honor the bridge's choice.
		const bridgePrefIdx =
			this.bridgeInProgressId !== null ? this.items.findIndex((i) => i.id === this.bridgeInProgressId) : -1;
		this.enforceOneInProgress(bridgePrefIdx >= 0 ? bridgePrefIdx : undefined);

		// GC stale programmatic ids.
		const liveIds = new Set(this.items.map((i) => i.id).filter(Boolean) as string[]);
		for (const id of this.programmaticIds) {
			if (!liveIds.has(id)) this.programmaticIds.delete(id);
		}

		// The model's list is authoritative for model-owned items — bridge-side
		// tracking for them is now stale.
		this.bridgeMutations.clear();
		this.bridgeRemovedIds.clear();
		this.pendingBridgeRenames.clear();
		this.bridgeInProgressId = null;
		this.autoCleanedContents.clear();
		this.lastAutoClearNotifyKey = null;
		this.cancelAutoClearTimer();

		this.persist();
		this.changed();

		return { items: this.getItems(), warnings };
	}

	// ── programmatic (bridge) API for other core modules ────────────────

	addItem(content: string, status: TodoStatus = "pending"): string | null {
		const sanitized = sanitizeContent(String(content ?? "").trim());
		if (!sanitized) return null;
		const s = String(status ?? "pending")
			.trim()
			.toLowerCase();
		if (!isValidTodoStatus(s)) return null;

		const existing = this.items.find((i) => i.content === sanitized);
		if (existing) {
			if (existing.id !== undefined) {
				this.programmaticIds.add(existing.id);
				this.bridgeMutations.delete(existing.id);
				this.pendingBridgeRenames.delete(existing.id);
			}
			this.cancelAutoClearTimer();
			if (existing.status !== s) {
				existing.status = s;
				this.recordBridgeMutation(existing);
			}
			if (s === "in_progress") {
				this.enforceOneInProgress(this.items.indexOf(existing));
				this.bridgeInProgressId = existing.id ?? null;
			} else if (existing.id !== undefined && this.bridgeInProgressId === existing.id) {
				this.bridgeInProgressId = null;
			}
			if (s === "pending" || s === "in_progress") {
				this.autoCleanedContents.delete(existing.content);
			}
			this.syncBridgeMutations();
			this.changed();
			this.checkAndAutoClear();
			return existing.id ?? null;
		}

		this.cancelAutoClearTimer();
		this.autoCleanedContents.delete(sanitized);
		const id = this.mintId();
		this.items.push({ id, content: sanitized, status: s });
		this.programmaticIds.add(id);
		if (s === "in_progress") {
			this.enforceOneInProgress(this.items.length - 1);
			this.bridgeInProgressId = id;
		}
		this.syncBridgeMutations();
		this.changed();
		this.checkAndAutoClear();
		return id;
	}

	private applyBridgeUpdate(idx: number, newStatus: TodoStatus, newContent: string | undefined): boolean {
		this.cancelAutoClearTimer();
		const item = this.items[idx];
		const oldContent = item.content;

		// Validate content first so status+content update atomically.
		if (newContent !== undefined) {
			const renamed = sanitizeContent(newContent.trim());
			if (!renamed) return false;
			if (this.items.some((it, j) => j !== idx && it.content === renamed)) return false;
			item.content = renamed;
			if (renamed !== oldContent) this.autoCleanedContents.delete(oldContent);
			if (item.id !== undefined) this.pendingBridgeRenames.delete(item.id);
		}

		item.status = newStatus;
		if (newStatus === "pending" || newStatus === "in_progress") {
			this.autoCleanedContents.delete(oldContent);
			this.autoCleanedContents.delete(item.content);
		}
		if (newStatus === "in_progress") {
			this.enforceOneInProgress(idx);
			this.bridgeInProgressId = item.id ?? null;
		} else if (item.id !== undefined && this.bridgeInProgressId === item.id) {
			this.bridgeInProgressId = null;
		}
		this.recordBridgeMutation(item);
		this.syncBridgeMutations();
		this.changed();
		this.checkAndAutoClear();
		return true;
	}

	updateItemById(id: string, newStatus: TodoStatus, newContent?: string): boolean {
		const key = String(id ?? "");
		if (!key) return false;
		const s = String(newStatus ?? "pending")
			.trim()
			.toLowerCase();
		if (!isValidTodoStatus(s)) return false;
		const idx = this.items.findIndex((item) => item.id === key);
		if (idx === -1) return false;
		return this.applyBridgeUpdate(idx, s, newContent);
	}

	updateItemByContent(content: string, newStatus: TodoStatus, newContent?: string): boolean {
		const sanitized = sanitizeContent(String(content ?? "").trim());
		if (!sanitized) return false;
		const s = String(newStatus ?? "pending")
			.trim()
			.toLowerCase();
		if (!isValidTodoStatus(s)) return false;
		let idx = this.items.findIndex((item) => item.content === sanitized);
		if (idx === -1) {
			const prefixMatches = this.items.filter((item) => item.content.startsWith(sanitized));
			if (prefixMatches.length === 1) idx = this.items.indexOf(prefixMatches[0]);
		}
		if (idx === -1) return false;
		return this.applyBridgeUpdate(idx, s, newContent);
	}

	private removeAt(idx: number): boolean {
		this.cancelAutoClearTimer();
		const [removed] = this.items.splice(idx, 1);
		this.autoCleanedContents.delete(removed.content);
		if (removed?.id !== undefined && this.bridgeInProgressId === removed.id) {
			this.bridgeInProgressId = null;
		}
		if (removed?.id !== undefined) {
			const wasProgrammatic = this.programmaticIds.has(removed.id);
			this.programmaticIds.delete(removed.id);
			if (!wasProgrammatic) {
				this.bridgeRemovedIds.add(removed.id);
				this.bridgeMutations.delete(removed.id);
				this.pendingBridgeRenames.delete(removed.id);
			}
		}
		this.changed();
		this.checkAndAutoClear();
		return true;
	}

	removeItemById(id: string): boolean {
		const key = String(id ?? "");
		if (!key) return false;
		const idx = this.items.findIndex((item) => item.id === key);
		if (idx === -1) return false;
		return this.removeAt(idx);
	}

	removeItemByContent(content: string): boolean {
		const sanitized = sanitizeContent(String(content ?? "").trim());
		if (!sanitized) return false;
		let idx = this.items.findIndex((i) => i.content === sanitized);
		if (idx === -1) {
			const prefixMatches = this.items.filter((i) => i.content.startsWith(sanitized));
			if (prefixMatches.length === 1) idx = this.items.indexOf(prefixMatches[0]);
		}
		if (idx === -1) return false;
		return this.removeAt(idx);
	}

	// ── progress items (ephemeral, subagent status) ─────────────────────

	setProgress(key: string, status: string, text: string): void {
		const safeKey = sanitizeContent(String(key ?? ""));
		if (!safeKey) return;
		this.progressItems.set(safeKey, {
			status: sanitizeContent(String(status ?? "")),
			content: sanitizeContent(String(text ?? "")),
		});
		this.changed();
	}

	clearProgress(key: string): void {
		const safeKey = sanitizeContent(String(key ?? ""));
		if (!safeKey) return;
		this.progressItems.delete(safeKey);
		this.changed();
	}

	// ── persistence ─────────────────────────────────────────────────────

	/** Snapshot persisted on every model todo_write (authoritative for model-owned items). */
	private persist(): void {
		// Exclude programmatic (bridge) items: they are ephemeral, code-owned
		// state (e.g. subagent status lines) and their in-memory bookkeeping
		// (programmaticIds) does not survive a session switch. Persisting them
		// would restore orphaned pending items the model never wrote — the
		// stale-todo reminder would then fire for ghosts.
		this.sessionManager.appendCustomEntry(TODO_SESSION_ENTRY_TYPE, {
			items: this.items
				.filter((i) => !this.isProgrammaticItem(i))
				.map((i) => ({ id: i.id, content: i.content, status: i.status })),
		});
	}

	/** Restore from the latest "todo" custom entry on the current branch. */
	private restoreFromBranch(): void {
		const branch = this.sessionManager.getBranch();
		let restored = false;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== TODO_SESSION_ENTRY_TYPE) continue;
			const data = entry.data as { items?: TodoItem[] } | undefined;
			if (!Array.isArray(data?.items)) break;

			for (const item of data.items) {
				if (item?.id != null) this.advanceCounterPast(String(item.id));
			}
			const safe: TodoItem[] = [];
			for (const item of data.items) {
				if (!item || typeof item !== "object") continue;
				const sanitized = sanitizeContent(String(item.content ?? ""));
				if (!sanitized) continue;
				safe.push({
					id: item.id != null ? String(item.id) : this.mintId(),
					content: sanitized,
					status: normalizeStatus(item.status),
				});
			}
			const dedupSeen = new Set<string>();
			this.items = safe.filter((item) => {
				if (dedupSeen.has(item.content)) return false;
				dedupSeen.add(item.content);
				return true;
			});
			restored = true;
			break;
		}
		if (!restored) {
			this.items = [];
		}
	}

	// ── session lifecycle ────────────────────────────────────────────────

	/** startup / reload / new / resume / fork: reset session-scoped state and restore. */
	onSessionStart(): void {
		this.cancelAutoClearTimer();
		this.lastAutoClearNotifyKey = null;
		this.sessionNonce = Date.now().toString(36);
		this.itemIdCounter = 0;
		this.autoCleanedContents.clear();

		this.restoreFromBranch();
		for (const item of this.items) {
			if (item.status === "completed" || item.status === "cancelled") {
				this.autoCleanedContents.add(item.content);
			}
		}
		// In-memory bridge state cannot survive a session switch.
		this.programmaticIds.clear();
		this.bridgeMutations.clear();
		this.bridgeRemovedIds.clear();
		this.pendingBridgeRenames.clear();
		this.progressItems.clear();
		this.bridgeInProgressId = null;
		this.enforceOneInProgress();
		this.changed();
	}

	/** agent_end: auto-clean completed model-owned items with a notification. */
	onAgentEnd(): void {
		this.cancelAutoClearTimer();
		const removable = this.items.filter(
			(i) => (i.status === "completed" || i.status === "cancelled") && !this.isProgrammaticItem(i),
		);
		if (removable.length === 0) return;
		const newlyDone = removable.filter((i) => !this.autoCleanedContents.has(i.content));
		if (newlyDone.length > 0) {
			const doneList = newlyDone.map((i) => `  ${STATUS_ICONS[i.status]} ${i.content}`).join("\n");
			const parts: string[] = [];
			const completed = newlyDone.filter((i) => i.status === "completed").length;
			if (completed > 0) parts.push(`✓ ${completed} completed`);
			const cancelled = newlyDone.filter((i) => i.status === "cancelled").length;
			if (cancelled > 0) parts.push(`✗ ${cancelled} cancelled`);
			this.callbacks.notify(`${parts.join(", ")}:\n${doneList}`, "info");
		}
		for (const i of removable) {
			this.autoCleanedContents.add(i.content);
			if (i.id !== undefined) {
				this.bridgeRemovedIds.add(i.id);
				this.bridgeMutations.delete(i.id);
				this.pendingBridgeRenames.delete(i.id);
			}
		}
		this.items = this.items.filter(
			(i) => (i.status !== "completed" && i.status !== "cancelled") || this.isProgrammaticItem(i),
		);
		this.lastAutoClearNotifyKey = null;
		this.changed();
	}

	/** /tree navigation: restore from branch, then replay bridge state over the stale snapshot. */
	onSessionTree(): void {
		this.cancelAutoClearTimer();
		const programmaticItems = this.items.filter((i) => this.isProgrammaticItem(i));
		this.restoreFromBranch();

		// Replay bridge removals — restore would resurrect them.
		if (this.bridgeRemovedIds.size > 0) {
			this.items = this.items.filter((i) => i.id === undefined || !this.bridgeRemovedIds.has(i.id));
		}

		// Replay bridge mutations of model-owned items.
		for (const [id, mutation] of this.bridgeMutations) {
			const idx = this.items.findIndex((i) => i.id === id);
			if (idx === -1) continue;
			const item = this.items[idx];
			item.status = mutation.status;
			if (!this.items.some((it, j) => j !== idx && it.content === mutation.content)) {
				item.content = mutation.content;
				this.pendingBridgeRenames.delete(id);
			} else {
				this.pendingBridgeRenames.add(id);
			}
			if (mutation.status === "in_progress") {
				this.bridgeInProgressId = item.id ?? null;
			} else if (item.id !== undefined && this.bridgeInProgressId === item.id) {
				this.bridgeInProgressId = null;
			}
		}

		// Re-add programmatic items wiped by restore; replace content-twins so
		// bridge ownership survives.
		for (const item of programmaticItems) {
			const sameIdIdx = this.items.findIndex((i) => i.id === item.id);
			if (sameIdIdx !== -1) {
				let idx = sameIdIdx;
				for (;;) {
					const twinIdx = this.items.findIndex((it, j) => j !== idx && it.content === item.content);
					if (twinIdx === -1) break;
					this.items.splice(twinIdx, 1);
					if (twinIdx < idx) idx--;
				}
				const finalIdx = this.items.findIndex((i) => i.id === item.id);
				if (finalIdx !== -1) this.items[finalIdx] = item;
				continue;
			}
			for (;;) {
				const twinIdx = this.items.findIndex((i) => i.content === item.content);
				if (twinIdx === -1) break;
				this.items.splice(twinIdx, 1);
			}
			this.items.push(item);
		}
		for (const item of programmaticItems) {
			if (item.id !== undefined) this.advanceCounterPast(item.id);
		}

		const bridgePreferredIdx =
			this.bridgeInProgressId !== null ? this.items.findIndex((i) => i.id === this.bridgeInProgressId) : -1;
		this.enforceOneInProgress(bridgePreferredIdx >= 0 ? bridgePreferredIdx : undefined);
		this.syncBridgeMutations();
		if (this.bridgeInProgressId !== null && !this.items.some((i) => i.id === this.bridgeInProgressId)) {
			this.bridgeInProgressId = null;
		}

		const remaining = this.items.filter((i) => !this.isProgrammaticItem(i));
		this.lastAutoClearNotifyKey =
			remaining.length > 0 && remaining.every((i) => i.status === "completed" || i.status === "cancelled")
				? remaining
						.map((i) => `${i.status}:${i.content}`)
						.sort()
						.join("\n")
				: null;

		this.autoCleanedContents.clear();
		for (const item of this.items) {
			if (item.status === "completed" || item.status === "cancelled") {
				this.autoCleanedContents.add(item.content);
			}
		}

		this.checkAndAutoClear();
		this.changed();
	}

	onShutdown(): void {
		this.cancelAutoClearTimer();
	}
}
