/**
 * Todo List extension — let pi plan complex tasks, track progress, and
 * display the current plan in a widget. Inspired by Claude Code's todo tool.
 *
 * Commands: /todo  (show current list)
 * Tool: todo_write  (create/update the task list)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── types ───────────────────────────────────────────────────────────────────

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];

interface TodoItem {
  id?: string;
  content: string;
  status: TodoStatus;
}

interface TodoList {
  items: TodoItem[];
}

const STATUS_ICONS: Record<TodoStatus, string> = {
  pending:     "○",
  in_progress: "◐",
  completed:   "✅",
  cancelled:   "✗",
};

/**
 * Last ExtensionContext.ui seen (tool execute / event handler).
 * ExtensionAPI itself exposes no `ui`, so bridge calls (which have no ctx)
 * fall back to this cached reference.
 */
let _ui: any = null;
/** Warn-once latch: a missing UI surface is logged once per gap, not on every render. */
let _uiDropWarned = false;
let todo: TodoList = { items: [] };
// Progress items survive session_tree restores (stored separately, not in todo.items)
const _progressItems = new Map<string, { status: string; content: string }>();
let detailWidgetActive = false;
let _autoClearTimer: ReturnType<typeof setTimeout> | null = null;
let _itemIdCounter = 0;
/** Per-session nonce prefixed to every minted id, so ids from different sessions (and therefore different branches) never collide in _bridgeRemovedIds or _bridgeMutations. Reset on session_start. */
let _sessionNonce = Date.now().toString(36);
/** Key of the done-list last notified by checkAndAutoClear — dedups repeat "All tasks complete" notifications. */
let _lastAutoClearNotifyKey: string | null = null;

/** Ids of items added via the bridge (addItem) — protected from session-tree restore wipes, auto-clean, and the all-done auto-clear. */
const _programmaticIds = new Set<string>();

/** Live state of model-owned items mutated via the bridge since the last todo_write — re-applied over the stale persisted snapshot on session_tree (restore would otherwise silently revert bridge-side status/content changes). */
const _bridgeMutations = new Map<string, { content: string; status: TodoStatus }>();

/** Ids of model-owned items removed via the bridge since the last todo_write — filtered out of the restored snapshot on session_tree so they are not resurrected. */
const _bridgeRemovedIds = new Set<string>();

/** Id of the item most recently set to in_progress by the bridge (updateItemById/updateItemByContent/addItem). Used as preferredIdx in session_tree's enforceOneInProgress so the bridge's choice survives restores. Cleared on todo_write and session_start. */
let _bridgeInProgressId: string | null = null;

/** Contents of done items already auto-cleaned + notified — dedups the session_tree done-notification (restore re-surfaces the same done items on every tree event). Entries are removed when an item re-opens so a later completion notifies again. */
const _autoCleanedContents = new Set<string>();

/** True if the item was added programmatically via the bridge. */
function isProgrammaticItem(item: TodoItem): boolean {
  return item.id !== undefined && _programmaticIds.has(item.id);
}

/** Record the live state of a model-owned item mutated via the bridge, so the session_tree handler can re-apply it over the stale persisted snapshot. */
function recordBridgeMutation(item: TodoItem): void {
  if (item.id !== undefined && !isProgrammaticItem(item)) {
    _bridgeMutations.set(item.id, { content: item.content, status: item.status });
  }
}

/** Refresh already-tracked bridge mutations from live state — e.g. after enforceOneInProgress demoted a tracked item. Does not start tracking new items. */
function syncBridgeMutations(): void {
  for (const item of todo.items) {
    if (item.id !== undefined && _bridgeMutations.has(item.id)) {
      _bridgeMutations.set(item.id, { content: item.content, status: item.status });
    }
  }
}

/** Shared update logic for bridge mutations — used by both updateItemByContent and updateItemById to avoid duplicated code drifting apart. */
function applyBridgeUpdate(idx: number, newStatus: TodoStatus, newContent: string | undefined, callerLabel: string): boolean {
  if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
  const item = todo.items[idx];
  const oldContent = item.content;

  // Validate newContent before applying any mutation, so status and content
  // are updated atomically — a rejected content rename no longer leaves a
  // partial status change in place (the caller sees true only when the full
  // update succeeded).
  if (newContent !== undefined) {
    const nc = sanitizeContent(newContent.trim());
    if (!nc) {
      console.warn(`todo-bridge: ${callerLabel} — newContent sanitized to empty; update rejected`);
      return false;
    }
    const renamed = truncate(nc, 200);
    if (todo.items.some((it, j) => j !== idx && it.content === renamed)) {
      console.warn(`todo-bridge: ${callerLabel} — newContent "${renamed}" duplicates an existing item; update rejected`);
      return false;
    }
    item.content = renamed;
    if (renamed !== oldContent) {
      _autoCleanedContents.delete(oldContent);
    }
  }

  item.status = newStatus;
  if (newStatus === "pending" || newStatus === "in_progress") {
    // Re-opened — allow a future completion of this content to notify again.
    _autoCleanedContents.delete(oldContent);
    _autoCleanedContents.delete(item.content);
  }
  if (newStatus === "in_progress") { enforceOneInProgress(idx); _bridgeInProgressId = item.id ?? null; }
  else if (item.id !== undefined && _bridgeInProgressId === item.id) { _bridgeInProgressId = null; }
  recordBridgeMutation(item);
  syncBridgeMutations(); // enforceOneInProgress may have demoted another tracked item
  renderWidget();
  checkAndAutoClear();
  clearDetailWidget();
  return true;
}

/** Queued notifications that arrived before the UI surface was ready — replayed when resolveUi first sees a ctx.ui. */
const _pendingNotifications: Array<{ message: string; level: string }> = [];

/** Resolve the UI surface: prefer an explicit ctx, and cache it so ctx-less bridge calls can still reach the UI. */
function resolveUi(ctx?: any): any {
  if (ctx?.ui) {
    const prevHadUi = !!_ui;
    _ui = ctx.ui;
    _uiDropWarned = false;
    // Replay any notifications queued before the UI surface was available
    if (!prevHadUi && _pendingNotifications.length > 0) {
      for (const n of _pendingNotifications) {
        ctx.ui.notify?.(n.message, n.level);
      }
      _pendingNotifications.length = 0;
    }
    // Re-render widget when UI surface transitions from null→available.
    // Bridge calls (addItem/updateItemById/etc.) that happened before the
    // first ctx-bearing event were silently dropped by the stub's no-op
    // setWidget — re-render now so they become visible.
    if (!prevHadUi) {
      renderWidget(ctx);
    }
    return ctx.ui;
  }
  if (!_ui) {
    if (!_uiDropWarned) {
      _uiDropWarned = true;
      console.debug("todo: no UI context available yet — notifications are queued until the first ctx-bearing tool/event runs");
    }
    // Return a stub that queues notifications so they are not lost
    return {
      notify(message: string, level: string) {
        if (_pendingNotifications.length < 200) {
          _pendingNotifications.push({ message, level });
        }
      },
      setWidget() { /* silently drop — widget re-renders on next ctx-bearing event */ },
    };
  }
  return _ui;
}

// ── global bridge: allow other extensions (e.g. subagent) to push/update items ──
// Also provides a progress store immune to session_tree restores
(globalThis as any).__pi_todo = {
  // ── regular todo items ──
  addItem(content: string, status: TodoStatus = "pending"): string | null {
    const trimmed = String(content ?? "").trim();
    if (!trimmed) { console.warn("todo-bridge: addItem — content cannot be empty"); return null; }
    const sanitized = sanitizeContent(trimmed);
    if (!sanitized) { console.warn("todo-bridge: addItem — content empty after sanitization"); return null; }
    const truncated = truncate(sanitized, 200);
    const s = String(status ?? "pending").trim().toLowerCase();
    if (!isValidTodoStatus(s)) {
      console.warn(`todo-bridge: addItem — invalid status "${String(status)}"; item not added`);
      return null;
    }
    // Return existing ID if duplicate — caller still gets a valid ID to use.
    // Also purge any stale auto-clean entry so a future completion of this
    // re-opened item will notify again.
    const existing = todo.items.find(i => i.content === truncated);
    if (existing) {
      // Protect the returned id so it survives auto-clean — the bridge contract
      // promises that ids returned by addItem are treated as programmatic.
      if (existing.id !== undefined) {
        _programmaticIds.add(existing.id);
        _bridgeMutations.delete(existing.id);  // was model-owned, now programmatic
      }
      // Honor the requested status on the existing item — the caller gets back
      // a valid id and reasonably assumes the status was applied.
      // Cancel any pending all-done auto-clear (common to both status-changed
      // and status-unchanged paths — extracted to avoid ~80% duplicated logic).
      if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }

      if (existing.status !== s) {
        existing.status = s;
        recordBridgeMutation(existing);
      }

      if (s === "in_progress") {
        enforceOneInProgress(todo.items.indexOf(existing));
        _bridgeInProgressId = existing.id ?? null;
      } else if (existing.id !== undefined && _bridgeInProgressId === existing.id) {
        _bridgeInProgressId = null;
      }

      // Re-opened — allow a future completion of this content to notify again.
      if (s === "pending" || s === "in_progress") {
        _autoCleanedContents.delete(existing.content);
      }

      syncBridgeMutations();
      renderWidget();
      checkAndAutoClear();
      clearDetailWidget();
      return existing.id ?? null;
    }
    // Cancel any pending all-done auto-clear only now that validation passed —
    // a failed call must not silently cancel a scheduled clear.
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    // Purge stale auto-clean entry so a future completion of this content notifies again
    _autoCleanedContents.delete(truncated);
    const id = `${_sessionNonce}_${++_itemIdCounter}`;
    todo.items.push({ id, content: truncated, status: s });
    _programmaticIds.add(id);
    if (s === "in_progress") { enforceOneInProgress(todo.items.length - 1); _bridgeInProgressId = id; }
    syncBridgeMutations(); // the new in_progress item may have demoted a tracked one
    renderWidget();
    checkAndAutoClear();
    clearDetailWidget();
    return id;
  },
  updateItemByContent(content: string, newStatus: TodoStatus, newContent?: string): boolean {
    const trimmed = String(content ?? "").trim();
    if (!trimmed) return false;
    const sanitized = sanitizeContent(trimmed);
    if (!sanitized) return false;
    const truncated = truncate(sanitized, 200);
    const s = String(newStatus ?? "pending").trim().toLowerCase();
    if (!isValidTodoStatus(s)) {
      console.warn(`todo-bridge: updateItemByContent — invalid status "${String(newStatus)}"; item unchanged`);
      return false;
    }
    // Prefer an exact match; fall back to a prefix match only when unambiguous
    // (a blind prefix match can hit the wrong item when one content prefixes another).
    let idx = todo.items.findIndex(item => item.content === truncated);
    if (idx === -1) {
      const prefixMatches = todo.items.filter(item => item.content.startsWith(truncated));
      if (prefixMatches.length === 1) idx = todo.items.indexOf(prefixMatches[0]);
    }
    if (idx !== -1) {
      return applyBridgeUpdate(idx, s, newContent, `updateItemByContent("${truncated}")`);
    }
    return false;
  },
  removeItemByContent(content: string): boolean {
    const trimmed = String(content ?? "").trim();
    if (!trimmed) return false;
    const sanitized = sanitizeContent(trimmed);
    if (!sanitized) return false;
    const truncated = truncate(sanitized, 200);
    let idx = todo.items.findIndex(i => i.content === truncated);
    if (idx === -1) {
      const prefixMatches = todo.items.filter(item => item.content.startsWith(truncated));
      if (prefixMatches.length === 1) idx = todo.items.indexOf(prefixMatches[0]);
    }
    if (idx !== -1) {
      if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
      const [removed] = todo.items.splice(idx, 1);
      _autoCleanedContents.delete(removed.content);
      if (removed?.id !== undefined && _bridgeInProgressId === removed.id) {
        _bridgeInProgressId = null;
      }
      if (removed?.id !== undefined) {
        const wasProgrammatic = _programmaticIds.has(removed.id);
        _programmaticIds.delete(removed.id);
        // Model-owned removal — remember it so session_tree restore (which re-reads
        // the stale persisted snapshot) does not resurrect the item.
        if (!wasProgrammatic) {
          _bridgeRemovedIds.add(removed.id);
          _bridgeMutations.delete(removed.id);
        }
      }
      renderWidget();
      checkAndAutoClear();
      clearDetailWidget();
      return true;
    }
    console.debug(`todo-bridge: removeItemByContent — no item found for content "${truncated}"`);
    return false;
  },
  updateItemById(id: string, newStatus: TodoStatus, newContent?: string): boolean {
    if (id == null || String(id).trim() === "") {
      console.warn(`todo-bridge: updateItemById — invalid id "${String(id)}"; item unchanged`);
      return false;
    }
    const s = String(newStatus ?? "pending").trim().toLowerCase();
    if (!isValidTodoStatus(s)) {
      console.warn(`todo-bridge: updateItemById — invalid status "${String(newStatus)}"; item unchanged`);
      return false;
    }
    // Coerce to string — JS callers may pass a numeric id (3 vs "3")
    const key = String(id);
    const idx = todo.items.findIndex(item => item.id === key);
    if (idx !== -1) {
      return applyBridgeUpdate(idx, s, newContent, `updateItemById("${key}")`);
    }
    console.debug(`todo-bridge: updateItemById — no item found for id "${String(id)}"`);
    return false;
  },
  removeItemById(id: string): boolean {
    if (id == null || String(id).trim() === "") {
      console.warn(`todo-bridge: removeItemById — invalid id "${String(id)}"; nothing removed`);
      return false;
    }
    // Coerce to string — JS callers may pass a numeric id (3 vs "3")
    const key = String(id);
    const idx = todo.items.findIndex(item => item.id === key);
    if (idx !== -1) {
      if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
      const [removed] = todo.items.splice(idx, 1);
      _autoCleanedContents.delete(removed.content);
      if (_bridgeInProgressId === key) {
        _bridgeInProgressId = null;
      }
      const wasProgrammatic = removed?.id !== undefined && _programmaticIds.has(removed.id);
      _programmaticIds.delete(key);
      // Model-owned removal — remember it so session_tree restore (which re-reads
      // the stale persisted snapshot) does not resurrect the item.
      if (!wasProgrammatic) {
        _bridgeRemovedIds.add(key);
        _bridgeMutations.delete(key);
      }
      renderWidget();
      checkAndAutoClear();
      clearDetailWidget();
      return true;
    }
    console.debug(`todo-bridge: removeItemById — no item found for id "${String(id)}"`);
    return false;
  },
  // Shallow-copy items so callers can't mutate internal state and break invariants
  // (e.g. one-in-progress). Items are flat ({id, content, status}) so a shallow copy
  // suffices — switch to a deep copy if a nested field is ever added.
  getItems() { return todo.items.map(i => ({ ...i })); },

  // ── progress items: survive session_tree restores ──
  setProgress(key: string, status: string, text: string) {
    const safeKey = truncate(sanitizeContent(String(key ?? "")), 100);
    if (!safeKey) { console.warn("todo-bridge: setProgress — key cannot be empty after sanitization"); return; }
    const safeStatus = truncate(sanitizeContent(String(status ?? "")), 50);
    const safeContent = truncate(sanitizeContent(String(text ?? "")), 200);
    _progressItems.set(safeKey, { status: safeStatus, content: safeContent });
    renderWidget();
    clearDetailWidget();
  },
  clearProgress(key: string) {
    const safeKey = truncate(sanitizeContent(String(key ?? "")), 100);
    if (!safeKey) { console.warn("todo-bridge: clearProgress — key cannot be empty after sanitization"); return; }
    _progressItems.delete(safeKey);
    renderWidget();
    clearDetailWidget();
  },
};

/** Narrow a string to a valid TodoStatus after user input or session restore. */
function isValidTodoStatus(s: string): s is TodoStatus {
  // Derive from TODO_STATUSES to avoid drift — single source of truth
  return (TODO_STATUSES as readonly string[]).includes(s);
}

/** Coerce an unknown status string to a valid TodoStatus, defaulting to pending. */
function normalizeStatus(raw: string | undefined): TodoStatus {
  if (!raw) return "pending";
  const s = String(raw).trim().toLowerCase();
  if (!isValidTodoStatus(s)) {
    console.warn(`todo: normalizeStatus — invalid status "${String(raw)}"; defaulting to "pending"`);
    return "pending";
  }
  return s;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences (CSI + SGR) and C0 control characters from
 * content before rendering into the widget.  Prevents user-supplied escape
 * codes from corrupting widget layout or injecting formatting.
 */
function sanitizeContent(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?>=<:]*[\x20-\x2F]*[@-~]/g, "")   // CSI sequences (include ? > = < : params, intermediate bytes)
    .replace(/\x1b\[[^\x1b]*/g, "")                     // Unterminated/malformed CSI (no final byte before ESC or EOS)
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")   // OSC sequences (with BEL or ST terminator)
    .replace(/\x1b\][^\x1b]*/g, "")               // Unterminated OSC (truncated input — no ST/BEL)
    .replace(/\x1b[PX^_].*?(?:\x07|\x1b\\)/g, "")        // DCS, SOS, PM, APC (with ST or BEL terminator)
    .replace(/\x1b[PX^_][^\x1b]*/g, "")         // Unterminated DCS/SOS/PM/APC (no ST terminator — truncated input edge case)
    .replace(/\x1b[\x20-\x2F]*[\x30-\x5A\x5C-\x7E]/g, "") // Remaining ESC sequences (exclude 0x5B '[' — CSI introducer)
    .replace(/[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g, "") // remaining C0 + C1 controls (bare ESC, CR, CSI, etc.)
    .replace(/\t/g, " ")
    .replace(/\n/g, " ")
    .replace(/\u2028|\u2029/g, " ")           // Unicode line/paragraph separators → space (like \n)
    .replace(/(\u200C|\u200D)|[\p{Cf}\p{Cs}]/gu, (m, keep) => keep || "");  // strip format chars & surrogates, preserve ZWJ/ZWNJ
}

/** Truncate a string to maxLen code points (surrogate-safe). */
function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return '…';
  const chars = Array.from(str);
  if (chars.length <= maxLen) return str;
  return chars.slice(0, maxLen - 1).join('') + '…';
}

/** Enforce the "only one in_progress" rule by demoting all but the preferred item.
 *  When preferredIdx is provided, that item is kept as in_progress (used when
 *  updateItemByContent or updateItemById sets a specific item to in_progress).
 *  Otherwise, the last in_progress item by index is kept (most recently added). */
function enforceOneInProgress(preferredIdx?: number): void {
  const inProgressIndices: number[] = [];
  for (let i = 0; i < todo.items.length; i++) {
    if (todo.items[i].status === "in_progress") {
      inProgressIndices.push(i);
    }
  }
  if (inProgressIndices.length > 1) {
    // Keep the preferred index (most recently updated), falling back to the last one (most recently added).
    // Validate preferredIdx: it must be in bounds and the item must actually be in_progress,
    // otherwise a caller passing a stale index would silently demote ALL in_progress items to pending.
    let keepIdx = inProgressIndices[inProgressIndices.length - 1];
    if (preferredIdx !== undefined && preferredIdx >= 0 && preferredIdx < todo.items.length && todo.items[preferredIdx].status === "in_progress") {
      keepIdx = preferredIdx;
    }
    for (const idx of inProgressIndices) {
      if (idx !== keepIdx) {
        todo.items[idx].status = "pending";
      }
    }
  }
}

/** Prune _autoCleanedContents entries whose content no longer appears in any live todo item.
 *  Prevents unbounded growth in long sessions with many one-shot tasks. */
function pruneAutoCleanedContents(): void {
  const liveContents = new Set(todo.items.map(i => i.content));
  for (const content of _autoCleanedContents) {
    if (!liveContents.has(content)) {
      _autoCleanedContents.delete(content);
    }
  }
}

/** Check if all items are done and schedule auto-clear if so. */
function checkAndAutoClear(ctx?: any): void {
  const items = todo.items;
  // Gate on model-owned items only: perpetually-pending programmatic items
  // must not block the "all done" auto-clear UX.
  const modelItems = items.filter(i => !isProgrammaticItem(i));
  const allDone = modelItems.length > 0 && modelItems.every(i => i.status === "completed" || i.status === "cancelled");
  if (!allDone) {
    // New activity — reset the notification dedup so the next all-done state notifies
    _lastAutoClearNotifyKey = null;
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    return;
  }
  // Dedup: repeated calls while the same all-done list stands (e.g. bridge status
  // updates) must not spam duplicate "All tasks complete" notifications.
  // Use modelItems (not items) so programmatic-item status/content changes don't
  // cause spurious notifications or incorrectly suppress a legitimate one.
  const doneKey = modelItems.map(i => `${i.status}:${i.content}`).sort().join("\n");
  if (doneKey !== _lastAutoClearNotifyKey) {
    _lastAutoClearNotifyKey = doneKey;
    const doneList = modelItems.map(i => `  ${STATUS_ICONS[i.status]} ${i.content}`).join("\n");
    const ui = resolveUi(ctx);
    ui?.notify?.(`All tasks complete:\n${doneList}`, "info");
    // Seed the session_tree done-dedup as well: if tree navigation lands inside
    // the 3s auto-clear window, the session_tree handler cancels the timer and
    // restores this same all-done snapshot — without these entries its
    // auto-clean would fire "✅ N task(s) done" again for the same items.
    for (const i of items) {
      if (!isProgrammaticItem(i)) _autoCleanedContents.add(i.content);
    }
  }
  if (detailWidgetActive) clearDetailWidget(ctx);
  if (_autoClearTimer !== null) clearTimeout(_autoClearTimer);
  _autoClearTimer = setTimeout(() => {
    _autoClearTimer = null;
    // Keep bridge-owned (programmatic) items — external callers hold their ids,
    // so wiping them here would silently invalidate those ids.
    const wiped = todo.items.filter(i => !isProgrammaticItem(i));
    todo = { items: todo.items.filter(isProgrammaticItem) };
    // Pre-seed the dedup key for any remaining done items so they don't re-notify
    const remaining = todo.items;
    _lastAutoClearNotifyKey = remaining.length > 0 && remaining.every(i => i.status === "completed" || i.status === "cancelled")
      ? remaining.map(i => `${i.status}:${i.content}`).sort().join("\n")
      : null;
    // Prune _autoCleanedContents entries that no longer correspond to any live item
    pruneAutoCleanedContents();
    // Remember the wiped done items (don't clear the set): a later session_tree
    // restore re-surfaces the same done items from the last todo_write details,
    // and without these entries the "task(s) done" notification would repeat.
    for (const i of wiped) _autoCleanedContents.add(i.content);
    // A /todo detail widget opened during the 3s window would show wiped items —
    // clear it explicitly and keep detailWidgetActive in sync.
    // Guard against the stub UI: if _ui is still null (no ctx-bearing event has
    // run yet), skip the render — the widget will refresh on the next event.
    if (_ui) {
      clearDetailWidget();
      renderWidget();
    }
  }, 3000);
}

/** Clear the full-detail widget and sync the toggle flag. */
function clearDetailWidget(ctx?: any): void {
  detailWidgetActive = false;
  resolveUi(ctx)?.setWidget?.("todo-detail", undefined);
}

/**
 * Find the most recent todo_write result in the session branch and
 * restore `todo` from it.
 */
function restoreFromBranch(ctx?: any): void {
  try {
    // Validate that required APIs exist before attempting to access them,
    // preventing silent failures if internal pi data structures change upstream.
    if (!ctx || typeof ctx !== 'object') return;
    if (!ctx.sessionManager || typeof ctx.sessionManager.getBranch !== 'function') {
      console.debug("restoreFromBranch: sessionManager.getBranch not available (format may have changed)");
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) {
      console.debug("restoreFromBranch: branch is not an array (format may have changed)");
      return;
    }
    // Iterate in reverse so the most recent todo_write wins
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      // Validate each entry's structure before accessing nested properties
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.toolName !== "todo_write") continue;
      const details = msg?.details as { items?: TodoItem[] } | undefined;
      if (!details || typeof details !== 'object') continue;
      // Array.isArray catches both populated and empty lists so that a
      // todo_write that cleared everything is honoured on restore.
      if (Array.isArray(details?.items)) {
        // Pre-pass: advance the counter past every persisted numeric id up front.
        // Advancing inside the main loop would let an id-less item mint an id
        // that a later persisted id then duplicates in a mixed snapshot (some
        // items with ids, some without) — updateItemById/removeItemById would
        // hit the wrong twin.
        for (const item of details.items) {
          if (item && typeof item === 'object' && item.id != null) {
            // Handle both nonce-prefixed ids ("lxq3k_5") and plain numeric ids
            const idStr = String(item.id);
            const n = idStr.includes('_') ? Number(idStr.split('_').pop()) : Number(idStr);
            _itemIdCounter = Math.max(Number.isFinite(_itemIdCounter) ? _itemIdCounter : 0, isNaN(n) ? 0 : n);
          }
        }
        // Validate each item individually to skip corrupted entries
        const safe: TodoItem[] = [];
        for (const item of details.items) {
          if (!item || typeof item !== 'object') continue;
          const sanitized = sanitizeContent(String(item.content ?? ""));
          if (!sanitized) continue;
          const id = item.id != null ? String(item.id) : `${_sessionNonce}_${++_itemIdCounter}`;
          safe.push({
            id,
            content: truncate(sanitized, 200),
            status: normalizeStatus(item.status),
          });
        }
        // Deduplicate by content to guard against corrupted persisted snapshots
        const deduped: TodoItem[] = [];
        const dedupSeen = new Set<string>();
        for (const item of safe) {
          if (!dedupSeen.has(item.content)) {
            dedupSeen.add(item.content);
            deduped.push(item);
          }
        }
        todo = { items: deduped };
        break;
      }
    }
  } catch (e) {
    console.warn("restoreFromBranch: failed to restore todo from branch", e);
  }
}

function renderWidget(ctx?: any): void {
  const ui = resolveUi(ctx);

  if (todo.items.length === 0 && _progressItems.size === 0) {
    ui.setWidget?.("todo", undefined);
    ui.setWidget?.("todo-detail", undefined);
    return;
  }

  const done = todo.items.filter(i => i.status === "completed" || i.status === "cancelled").length;
  const total = todo.items.length;

  // Show ALL items in order, like Claude Code
  const lines: string[] = [];
  if (todo.items.length > 0) {
    lines.push(`Todo (${done}/${total})`);
  }

  for (const item of todo.items) {
    const icon = STATUS_ICONS[item.status] || "○";
    const bold = item.status === "in_progress" ? "\x1b[1m" : "";
    const reset = item.status === "in_progress" ? "\x1b[0m" : "";
    lines.push(`${bold}${icon} ${truncate(item.content, 60)}${reset}`);
  }

  // Render progress items (set via bridge setProgress/clearProgress)
  if (_progressItems.size > 0) {
    if (todo.items.length > 0) {
      lines.push(""); // blank separator between todo and progress sections
    }
    lines.push("Progress");
    for (const [key, prog] of _progressItems) {
      lines.push(`  ⏳ [${truncate(key, 20)}] ${truncate(prog.status, 20)}: ${truncate(prog.content, 60)}`);
    }
  }

  ui.setWidget?.("todo", lines);
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── todo_write tool ──────────────────────────────────────────────────
  pi.registerTool({
    name: "todo_write",
    label: "Todo Write",
    description:
      "Create and manage a structured task list for your current coding session. " +
      "Use this to plan complex multi-step tasks, track progress, and demonstrate thoroughness.\n\n" +
      "Each item has a status: pending (not started), in_progress (currently working on), " +
      "completed (done), cancelled (no longer needed).\n\n" +
      "Only ONE item should be in_progress at a time. Complete current items before starting new ones.",
    promptSnippet: "Plan tasks before executing: todo_write → work → mark done.",
    promptGuidelines: [
      "MANDATORY: Use todo_write BEFORE any task with 3+ steps. Plan first, then execute.",
      "Mark exactly ONE item in_progress at a time. Complete before starting next.",
      "Update status as you work: pending → in_progress → completed/cancelled.",
    ],
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        content: Type.String({ description: "Task description (short and action-oriented)", minLength: 1 }),
        status: Type.Optional(Type.String({ description: "Status: pending (default), in_progress, completed, cancelled" })),
      }), { description: "The complete todo list. Replaces all previous items." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {

      const warnings: string[] = [];

      // Validate and normalize
      if (!Array.isArray(params.items)) {
        throw new Error(`Expected items to be an array, got ${typeof params.items}`);
      }

      // Cap items before processing to prevent unnecessary work on large arrays
      const totalProvided = params.items.length;
      if (totalProvided > 100) {
        warnings.push(`List capped at 100 items (${totalProvided} provided). The first 100 items were kept.`);
      }
      const slice = params.items.slice(0, 100);

      let items: TodoItem[] = slice.map((item: { content: string; status?: string }, i: number) => {
        if (!item || typeof item !== 'object') throw new Error(`Todo item ${i + 1} is not an object`);
        const content = (item.content || "").trim();
        // Sanitize BEFORE empty check and truncation to avoid splitting ANSI escape
        // sequences mid-sequence and to catch content that is only escape codes.
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

        return { id: `${_sessionNonce}_${++_itemIdCounter}`, content: truncate(sanitized, 200), status };
      });

      // Remove duplicate items, keeping only the first occurrence of each unique content.
      // This is consistent with the bridge addItem which also rejects duplicates.
      // Dedup first so that enforce-one-in-progress below operates on a clean list.
      const seen = new Set<string>();
      items = items.filter(item => {
        if (seen.has(item.content)) {
          const preview = truncate(item.content, 40);
          warnings.push(`Duplicate item: "${preview}" — keeping only first occurrence.`);
          return false;
        }
        seen.add(item.content);
        return true;
      });

      // Enforce: only one in_progress
      const inProgress = items.filter(i => i.status === "in_progress");
      if (inProgress.length > 1) {
        // Auto-fix: keep the last one as in_progress, demote the rest to pending
        const lastInProgressIdx = items.reduce((last, item, idx) =>
          item.status === "in_progress" ? idx : last, -1);
        let demoted = 0;
        for (let i = 0; i < items.length; i++) {
          if (items[i].status === "in_progress" && i !== lastInProgressIdx) {
            items[i].status = "pending";
            demoted++;
          }
        }
        warnings.push(`Auto-fixed: demoted ${demoted} extra in_progress item(s) → pending (only one allowed).`);
      }

      // Preserve programmatic items (added via bridge) — they survive model todo_write.
      // Bridge callers holding ids from addItem expect them to remain valid.
      const programmaticItems = todo.items.filter(isProgrammaticItem);

      todo = { items };

      // Re-add programmatic items that the model didn't include.
      // When a programmatic item's content matches a model-owned item,
      // replace the model-owned twin with the programmatic one so the
      // programmatic id survives the stale-id GC below (otherwise the
      // bridge permanently loses ownership of that content).
      for (const prog of programmaticItems) {
        const twinIdx = todo.items.findIndex(i => i.content === prog.content);
        if (twinIdx === -1) {
          todo.items.push(prog);
        } else {
          todo.items[twinIdx] = prog;
        }
      }

      // Re-enforce after re-adding programmatic items to prevent two in_progress items.
      // Honor the bridge's explicit in_progress choice so programmatic items re-added
      // at lower indices (via content-twin replacement) are not silently demoted.
      const bridgePrefIdx = _bridgeInProgressId !== null
        ? todo.items.findIndex(i => i.id === _bridgeInProgressId)
        : -1;
      enforceOneInProgress(bridgePrefIdx >= 0 ? bridgePrefIdx : undefined);

      // Clean up stale programmatic ids (items no longer present in the merged list)
      const liveIds = new Set(todo.items.map(i => i.id).filter(Boolean) as string[]);
      const staleProgIds: string[] = [];
      for (const id of _programmaticIds) {
        if (!liveIds.has(id)) staleProgIds.push(id);
      }
      for (const id of staleProgIds) {
        _programmaticIds.delete(id);
      }

      // The model rewrote model-owned items — bridge-tracked mutations/removals for
      // model-owned items are now stale (the model's list is authoritative).
      _bridgeMutations.clear();
      _bridgeRemovedIds.clear();
      _bridgeInProgressId = null;
      _autoCleanedContents.clear();
      renderWidget(ctx);
      // Cancel any pending auto-clear
      if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }

      // Count by status for response
      const counts: Record<string, number> = {};
      for (const item of items) { counts[item.status] = (counts[item.status] || 0) + 1; }

      const summary = items.length === 0
        ? ["Todo list cleared."]
        : [
            `Todo list updated (${items.length} items):`,
            ...Object.entries(counts).map(([s, n]) => {
              const icon = STATUS_ICONS[s as TodoStatus] || "○";
              return `  ${icon} ${n} ${s.replace("_", " ")}`;
            }),
            ...(warnings.length > 0 ? ["", "⚠ warnings:", ...warnings.map(w => `  ${w}`)] : []),
          ];


      // Clear detail widget since todo was updated
      clearDetailWidget(ctx);

      // Persist ids in details so restoreFromBranch keeps them stable and
      // updateItemById/removeItemById remain valid across session_start/session_tree.
      // Bridge-side mutations to model-owned items are tracked in
      // _bridgeMutations/_bridgeRemovedIds and re-applied over this (stale) snapshot
      // on session_tree; on session_start they are dropped since a fresh session
      // rotates _sessionNonce (ids are now nonce-prefixed, preventing cross-session
      // collisions).
      return { content: [{ type: "text", text: summary.join("\n") }], details: { count: items.length, counts, items: items.map(i => ({ id: i.id, content: i.content, status: i.status })) } };
    },
  });

  // ── /todo command ────────────────────────────────────────────────────
  pi.registerCommand("todo", {
    description: "Show the current todo list",
    handler: async (_args, ctx) => {
      const ui = resolveUi(ctx);
      if (!ui) return;

      if (todo.items.length === 0) {
        ui.notify?.("No todo items yet. Use todo_write to create a plan.", "info");
        return;
      }

      const statusOrder: TodoStatus[] = ["in_progress", "pending", "completed", "cancelled"];
      // Map unknown statuses to one past the last known rank so they sort last
      const statusRank = (s: string): number => {
        const idx = statusOrder.indexOf(s as TodoStatus);
        return idx === -1 ? statusOrder.length : idx;
      };
      const total = todo.items.length;
      const done = todo.items.filter(i => i.status === "completed" || i.status === "cancelled").length;

      // Stable sort: primary key is status rank, secondary is original index
      const sorted = todo.items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const statusDiff = statusRank(a.item.status) - statusRank(b.item.status);
          if (statusDiff !== 0) return statusDiff;
          return a.index - b.index;
        })
        .map(({ item }) => item);

      // Build detail widget lines (capped to prevent TUI overflow)
      const MAX_DETAIL_LINES = 25;
      const detailLines: string[] = [];
      detailLines.push(`┌─ Todo detail (${done}/${total} done) ─────────────`);
      const limit = Math.min(sorted.length, MAX_DETAIL_LINES);
      for (let i = 0; i < limit; i++) {
        const item = sorted[i];
        const icon = STATUS_ICONS[item.status] || "○";
        const safeContent = truncate(sanitizeContent(item.content), 60);
        if (item.status === "in_progress") {
          detailLines.push(`│ \x1b[1m${icon}\x1b[0m \x1b[1m${safeContent}\x1b[0m`);
        } else {
          detailLines.push(`│ ${icon} ${safeContent}`);
        }
      }
      const remaining = sorted.length - limit;
      if (remaining > 0) {
        detailLines.push(`│ ... and ${remaining} more item(s)`);
      }
      detailLines.push(`└──────────────────────────────────────────`);
      detailLines.push(`(${total} items · /todo to toggle)`);

      if (detailWidgetActive) {
        // Toggle off
        ui.setWidget?.("todo-detail", undefined);
        detailWidgetActive = false;
        ui.notify?.(`Todo detail hidden (${done}/${total} done)`, "info");
      } else {
        // Show detail
        ui.setWidget?.("todo-detail", detailLines);
        detailWidgetActive = true;
        ui.notify?.(`Todo detail shown (${done}/${total} done). /todo to hide.`, "info");
      }
    },
  });

  // ── session_start: restore widget on resume ─────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Clear any stale auto-clear timer from a previous session
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    _lastAutoClearNotifyKey = null;
    // Rotate the session nonce so ids minted in this session cannot collide
    // with ids from previous sessions (and therefore previous branches).
    _sessionNonce = Date.now().toString(36);
    _itemIdCounter = 0;
    // Contents cleaned in a prior session must not suppress done-notifications
    // for coincidentally matching items in the resumed session.
    _autoCleanedContents.clear();

    // Restore state from the most recent todo_write in the session branch
    restoreFromBranch(ctx);
    // Seed auto-cleaned contents with any already-done items from the restored
    // snapshot, so they are not re-notified as "newly done" on the first
    // session_tree event after resume.
    for (const item of todo.items) {
      if (item.status === "completed" || item.status === "cancelled") {
        _autoCleanedContents.add(item.content);
      }
    }
    // In-memory bridge items cannot survive a session switch, so clear the set
    // outright: pruning against restored ids could false-positive when a stale
    // bridge id collides with a persisted restored id (id counters overlap
    // across processes), wrongly exempting a model-owned item from auto-clean.
    _programmaticIds.clear();
    // Bridge mutations/removals also target ids from the previous session — drop
    // them for the same cross-session id-collision reason.
    _bridgeMutations.clear();
    _bridgeRemovedIds.clear();
    _progressItems.clear();
    _bridgeInProgressId = null;
    // A corrupted snapshot could contain multiple in_progress items — enforce
    // the invariant defensively (mirrors session_tree's call after reconcile).
    enforceOneInProgress();
    // Always start with the compact widget (not the detail view)
    clearDetailWidget(ctx);
    renderWidget(ctx);
  });

  // ── session_tree: rebuild state after tree navigation ────────────────
  pi.on("session_tree", async (_event, ctx) => {
    console.error("[todo] session_tree fired — cleaning completed items");
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    // Protect programmatically-added items (tracked by id via the bridge) from being
    // wiped by restore — content-based heuristics would miss arbitrary bridge items
    // and false-positive on user items containing magic substrings.
    const programmaticItems = todo.items.filter(isProgrammaticItem);
    restoreFromBranch(ctx);
    // Capture ids present in the restored snapshot before filtering, so we can
    // garbage-collect stale _bridgeRemovedIds entries below.
    let restoredIds = new Set(todo.items.map(i => i.id).filter(Boolean) as string[]);
    // Re-apply bridge removals of model-owned items — the persisted snapshot is
    // stale (todo_write hasn't run since), so restore would resurrect them.
    if (_bridgeRemovedIds.size > 0) {
      todo.items = todo.items.filter(i => i.id === undefined || !_bridgeRemovedIds.has(i.id));
      // Clean up stale entries: ids that are no longer in the restored snapshot
      // were already removed by a todo_write on this branch, so tracking them is
      // unnecessary. This bounds _bridgeRemovedIds growth between todo_write calls.
      // Two-pass to avoid Set.delete() during for...of iteration (spec-leaves
      // mutation-during-iteration behaviour implementation-defined).
      const staleRemovedIds: string[] = [];
      for (const id of _bridgeRemovedIds) {
        if (!restoredIds.has(id)) {
          staleRemovedIds.push(id);
        }
      }
      for (const id of staleRemovedIds) {
        _bridgeRemovedIds.delete(id);
      }
      // Re-compute restoredIds after filtering so the _bridgeMutations GC below
      // only considers ids that survived _bridgeRemovedIds filtering.
      restoredIds = new Set(todo.items.map(i => i.id).filter(Boolean) as string[]);
    }
    // Re-apply bridge mutations to model-owned items — restore would otherwise
    // silently revert bridge-side status/content changes (e.g. an item completed
    // via the bridge would come back as pending).
    for (const [id, mutation] of _bridgeMutations) {
      const idx = todo.items.findIndex(i => i.id === id);
      if (idx === -1) continue; // a snapshot from another branch never had this id
      const item = todo.items[idx];
      item.status = mutation.status;
      // Apply the content change only when it cannot collide — dropping a
      // coincidental content-twin from another branch would lose a task.
      if (!todo.items.some((it, j) => j !== idx && it.content === mutation.content)) {
        item.content = mutation.content;
      }
      // Keep _bridgeInProgressId in sync (mirrors applyBridgeUpdate logic).
      if (mutation.status === "in_progress") {
        _bridgeInProgressId = item.id ?? null;
      } else if (item.id !== undefined && _bridgeInProgressId === item.id) {
        _bridgeInProgressId = null;
      }
    }
    // Garbage-collect stale _bridgeMutations entries for ids that have vanished
    // from all branch snapshots, so the map doesn't grow without bound across
    // many tree navigations between todo_write calls.
    // Two-pass to avoid Map.delete() during iteration (same spec concern as the
    // _bridgeRemovedIds cleanup above).
    const staleMutationIds: string[] = [];
    for (const id of _bridgeMutations.keys()) {
      if (!restoredIds.has(id)) {
        staleMutationIds.push(id);
      }
    }
    for (const id of staleMutationIds) {
      _bridgeMutations.delete(id);
    }
    // Re-add items that were wiped by restore. Match by id only: a restored item
    // with identical content but a different id must not cause the programmatic
    // item to be dropped — replace that unprotected twin so bridge ownership
    // (and protection from auto-clean) survives.
    for (const item of programmaticItems) {
      let sameIdIdx = todo.items.findIndex(i => i.id === item.id);
      if (sameIdIdx !== -1) {
        // A restored item fabricated the same id — the restored snapshot is stale.
        // Keep the live programmatic item so bridge-side status/content changes
        // made since the last todo_write are not silently reverted.
        // Also drop a content-twin at a different index first: a snapshot carrying
        // this item's content under another id would otherwise leave two items with
        // identical content, breaking the uniqueness invariant that content-keyed ops
        // (updateItemByContent exact-match, removeItemByContent, _autoCleanedContents)
        // rely on.
        // Remove ALL content-twins at other indices (not just one).
        // A single findIndex+splice would leave a second twin if the snapshot
        // somehow contains multiple items with identical content.
        while (true) {
          const twinIdx = todo.items.findIndex((i, j) => j !== sameIdIdx && i.content === item.content);
          if (twinIdx === -1) break;
          todo.items.splice(twinIdx, 1);
          if (twinIdx < sameIdIdx) sameIdIdx--;
        }
        // The splices may have shifted indices — re-locate by id before replacing.
        const finalIdx = todo.items.findIndex(i => i.id === item.id);
        if (finalIdx !== -1) todo.items[finalIdx] = item;
        continue;
      }
      // Remove ALL content-twins (not just one) before re-adding.
      while (true) {
        const twinIdx = todo.items.findIndex(i => i.content === item.content);
        if (twinIdx === -1) break;
        todo.items.splice(twinIdx, 1);
      }
      todo.items.push(item);
    }
    // Advance the counter past any programmatic id so the next addItem() or
    // model todo_write won't mint a duplicate id (collision would break
    // updateItemById, removeItemById, isProgrammaticItem, and _bridgeMutations).
    for (const item of programmaticItems) {
      if (item.id !== undefined) {
        const idStr = String(item.id);
        const n = idStr.includes('_') ? Number(idStr.split('_').pop()) : Number(idStr);
        if (!isNaN(n)) _itemIdCounter = Math.max(_itemIdCounter, n);
      }
    }
    // A restored in_progress plus a re-added in_progress could coexist — enforce the invariant.
    // Prefer the bridge's latest in_progress choice so it isn't demoted by a stale
    // persisted snapshot that still marks a previously-demoted item as in_progress.
    const bridgePreferredIdx = _bridgeInProgressId !== null
      ? todo.items.findIndex(i => i.id === _bridgeInProgressId)
      : -1;
    enforceOneInProgress(bridgePreferredIdx >= 0 ? bridgePreferredIdx : undefined);
    syncBridgeMutations();
    clearDetailWidget(ctx);

    // Auto-clean: remove completed/cancelled items, but never protected
    // programmatic items (they are owned by the bridge caller).
    const removable = todo.items.filter(i =>
      (i.status === "completed" || i.status === "cancelled") && !isProgrammaticItem(i));
    if (removable.length > 0) {
      // Only notify for items not already cleaned: restoreFromBranch re-reads the
      // last todo_write result on every tree event, so without this the notification
      // would fire again each time for the same items.
      const newlyDone = removable.filter(i => !_autoCleanedContents.has(i.content));
      if (newlyDone.length > 0) {
        const doneList = newlyDone.map(i => `  ${STATUS_ICONS[i.status]} ${i.content}`).join("\n");
        const completedCt = newlyDone.filter(i => i.status === "completed").length;
        const cancelledCt = newlyDone.filter(i => i.status === "cancelled").length;
        const parts: string[] = [];
        if (completedCt > 0) parts.push(`✅ ${completedCt} completed`);
        if (cancelledCt > 0) parts.push(`✗ ${cancelledCt} cancelled`);
        const label = parts.join(", ");
        const ui = resolveUi(ctx);
        ui?.notify?.(`${label}:\n${doneList}`, "info");
      }
      // Prune stale entries no longer relevant to the live list
      pruneAutoCleanedContents();
      // Remember cleaned contents so this notification doesn't repeat on the next
      // tree event (restore re-surfaces the same done items every time)
      for (const i of removable) _autoCleanedContents.add(i.content);
      // Remove completed items at turn end, notify user
      todo.items = todo.items.filter(i =>
        (i.status !== "completed" && i.status !== "cancelled") || isProgrammaticItem(i));
      // Prevent perpetual restore-remove loop: items removed here would be
      // resurrected by restoreFromBranch on the next session_tree (the
      // persisted todo_write snapshot is stale).  Add their ids to
      // _bridgeRemovedIds so the restore filter drops them, and clear any
      // _bridgeMutations entries so they become eligible for GC.
      for (const item of removable) {
        if (item.id !== undefined) {
          _bridgeRemovedIds.add(item.id);
          _bridgeMutations.delete(item.id);
        }
      }
    }
    // Clear stale bridge progress id when the referenced item is absent from the
    // restored branch, even when no items were removable (all pending).
    if (_bridgeInProgressId !== null && !todo.items.some(i => i.id === _bridgeInProgressId)) {
      _bridgeInProgressId = null;
    }

    // Keep the all-done notify dedup in sync with the post-restore list: a stale
    // key from before tree navigation would wrongly suppress the next
    // "All tasks complete" notification if the model writes an identical
    // all-done list (mirrors the auto-clear timer callback's re-seeding).
    const remaining = todo.items;
    _lastAutoClearNotifyKey = remaining.length > 0 && remaining.every(i => i.status === "completed" || i.status === "cancelled")
      ? remaining.map(i => `${i.status}:${i.content}`).sort().join("\n")
      : null;

    checkAndAutoClear(ctx);
    renderWidget(ctx);
  });

  // ── session_shutdown: clear widgets, keep state for restore ─────────
  pi.on("session_shutdown", async (_event, ctx) => {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    try {
      const ui = resolveUi(ctx);
      ui?.setWidget?.("todo", undefined);
      ui?.setWidget?.("todo-detail", undefined);
    } catch { /* ignore */ }
    detailWidgetActive = false;
  });
}
