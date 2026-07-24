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
  updatedAt: number;
}

const STATUS_ICONS: Record<TodoStatus, string> = {
  pending:     "○",
  in_progress: "◐",
  completed:   "✅",
  cancelled:   "✗",
};

let _pi: ExtensionAPI | null = null;
let todo: TodoList = { items: [], updatedAt: 0 };
let detailWidgetActive = false;
let _autoClearTimer: ReturnType<typeof setTimeout> | null = null;
let _notify: ((message: string, level?: string) => void) | null = null;
let _itemIdCounter = 0;

// ── global bridge: allow other extensions (e.g. subagent) to push/update items ──
(globalThis as any).__pi_todo = {
  addItem(content: string, status: TodoStatus = "pending"): string | null {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    const trimmed = String(content ?? "").trim();
    if (!trimmed) throw new Error("Todo item content cannot be empty");
    const sanitized = sanitizeContent(trimmed);
    if (!sanitized) throw new Error("Todo item content is empty after sanitization");
    const truncated = truncate(sanitized, 200);
    const s = String(status).trim().toLowerCase();
    const validStatus = isValidTodoStatus(s) ? s : "pending";
    // Reject duplicates — return null so callers know the item wasn't added
    if (todo.items.some(i => i.content === truncated)) {
      console.warn(`todo-bridge: duplicate item — "${truncated}" already exists`);
      return null;
    }
    const id = String(++_itemIdCounter);
    todo.items.push({ id, content: truncated, status: validStatus });
    if (validStatus === "in_progress") enforceOneInProgress(todo.items.length - 1);
    todo.updatedAt = Date.now();
    renderWidget();
    checkAndAutoClear();
    clearDetailWidget();
    return id;
  },
  updateItemByContent(content: string, newStatus: TodoStatus, newContent?: string): boolean {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    const trimmed = String(content ?? "").trim();
    if (!trimmed) return false;
    const sanitized = sanitizeContent(trimmed);
    if (!sanitized) return false;
    const truncated = truncate(sanitized, 200);
    const s = String(newStatus).trim().toLowerCase();
    const valid = isValidTodoStatus(s) ? s : "pending";
    const idx = todo.items.findIndex(item => item.content === truncated);
    if (idx !== -1) {
      const item = todo.items[idx];
      item.status = valid;
      if (newContent !== undefined) {
        const nc = sanitizeContent(String(newContent ?? "").trim());
        if (nc) {
          item.content = truncate(nc, 200);
        } else {
          console.warn(`todo-bridge: updateItemByContent — newContent for "${truncated}" sanitized to empty; content unchanged`);
        }
      }
      if (valid === "in_progress") enforceOneInProgress(idx);
      todo.updatedAt = Date.now();
      renderWidget();
      checkAndAutoClear();
      clearDetailWidget();
      return true;
    }
    console.debug(`todo-bridge: updateItemByContent — no item found for content "${truncated}"`);
    return false;
  },
  removeItemByContent(content: string): boolean {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    const trimmed = String(content ?? "").trim();
    if (!trimmed) return false;
    const sanitized = sanitizeContent(trimmed);
    if (!sanitized) return false;
    const truncated = truncate(sanitized, 200);
    const idx = todo.items.findIndex(i => i.content === truncated);
    if (idx !== -1) {
      todo.items.splice(idx, 1);
      todo.updatedAt = Date.now();
      renderWidget();
      checkAndAutoClear();
      clearDetailWidget();
      return true;
    }
    console.debug(`todo-bridge: removeItemByContent — no item found for content "${truncated}"`);
    return false;
  },
  updateItemById(id: string, newStatus: TodoStatus, newContent?: string): boolean {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    const s = String(newStatus).trim().toLowerCase();
    const valid = isValidTodoStatus(s) ? s : "pending";
    const idx = todo.items.findIndex(item => item.id === id);
    if (idx !== -1) {
      const item = todo.items[idx];
      item.status = valid;
      if (newContent !== undefined) {
        const nc = sanitizeContent(String(newContent ?? "").trim());
        if (nc) {
          item.content = truncate(nc, 200);
        } else {
          console.warn(`todo-bridge: updateItemById — newContent for item "${id}" sanitized to empty; content unchanged`);
        }
      }
      if (valid === "in_progress") enforceOneInProgress(idx);
      todo.updatedAt = Date.now();
      renderWidget();
      checkAndAutoClear();
      clearDetailWidget();
      return true;
    }
    console.debug(`todo-bridge: updateItemById — no item found for id "${id}"`);
    return false;
  },
  removeItemById(id: string): boolean {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    const idx = todo.items.findIndex(item => item.id === id);
    if (idx !== -1) {
      todo.items.splice(idx, 1);
      todo.updatedAt = Date.now();
      renderWidget();
      checkAndAutoClear();
      clearDetailWidget();
      return true;
    }
    console.debug(`todo-bridge: removeItemById — no item found for id "${id}"`);
    return false;
  },
  getItems() { return [...todo.items]; },
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
  return isValidTodoStatus(s) ? s : "pending";
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
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")   // OSC sequences (with BEL or ST terminator)
    .replace(/\x1b\][^\x1b]*/g, "")               // Unterminated OSC (truncated input — no ST/BEL)
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")        // DCS, SOS, PM, APC (with ST terminator)
    .replace(/\x1b[PX^_][^\x1b]*/g, "")         // Unterminated DCS/SOS/PM/APC (no ST terminator — truncated input edge case)
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, "") // Remaining ESC sequences (single-byte like ESC c, ESC 7, etc.)
    .replace(/[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g, "") // remaining C0 + C1 controls (bare ESC, CR, CSI, etc.)
    .replace(/\t/g, " ")
    .replace(/\n/g, " ")
    .replace(/[\p{Cf}\p{Cs}]/gu, "");        // Unicode format chars + surrogates
}

/** Truncate a string to maxLen code points (surrogate-safe). */
function truncate(str: string, maxLen: number): string {
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
    // Keep the preferred index (most recently updated), falling back to the last one (most recently added)
    const keepIdx = preferredIdx !== undefined ? preferredIdx : inProgressIndices[inProgressIndices.length - 1];
    for (const idx of inProgressIndices) {
      if (idx !== keepIdx) {
        todo.items[idx].status = "pending";
      }
    }
  }
}

/** Check if all items are done and schedule auto-clear if so. */
function checkAndAutoClear(ctx?: any): void {
  const items = todo.items;
  const allDone = items.length > 0 && items.every(i => i.status === "completed" || i.status === "cancelled");
  if (allDone) {
    const doneList = items.map(i => `  ${STATUS_ICONS[i.status]} ${i.content}`).join("\n");
    const truncatedList = doneList.length > 500 ? truncate(doneList, 500) + "\n  … and more" : doneList;
    const notify = ctx?.ui?.notify?.bind(ctx?.ui) ?? _notify;
    if (notify) (notify as any)(`All tasks complete:\n${truncatedList}`, "info");
    clearDetailWidget(ctx);
    if (_autoClearTimer !== null) clearTimeout(_autoClearTimer);
    _autoClearTimer = setTimeout(() => {
      _autoClearTimer = null;
      todo = { items: [], updatedAt: Date.now() };
      renderWidget();
    }, 3000);
  }
}

/** Clear the full-detail widget and sync the toggle flag. */
function clearDetailWidget(ctx?: any): void {
  detailWidgetActive = false;
  ctx?.ui?.setWidget?.("todo-detail", undefined);
  _pi?.ui?.setWidget?.("todo-detail", undefined);
}

/**
 * Find the most recent todo_write result in the session branch and
 * restore `todo` from it.
 */
function restoreFromBranch(ctx?: any): void {
  todo = { items: [], updatedAt: 0 };
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
        // Validate each item individually to skip corrupted entries
        const safe: TodoItem[] = [];
        for (const item of details.items) {
          if (!item || typeof item !== 'object') continue;
          const sanitized = sanitizeContent(String(item.content ?? ""));
          if (!sanitized) continue;
          safe.push({
            id: item.id || String(++_itemIdCounter),
            content: truncate(sanitized, 200),
            status: normalizeStatus(item.status),
          });
        }
        todo = { items: safe, updatedAt: Date.now() };
        break;
      }
    }
  } catch (e) {
    console.debug("restoreFromBranch: failed to restore todo from branch", e);
  }
}

function renderWidget(ctx?: any): void {
  const ui = ctx?.ui ?? _pi?.ui;
  if (!ui) return;

  const active = todo.items.filter(i => i.status === "pending" || i.status === "in_progress");
  if (active.length === 0) {
    ui.setWidget("todo", undefined);
    ui.setWidget("todo-detail", undefined);
    detailWidgetActive = false;
    return;
  }

  const done = todo.items.filter(i => i.status === "completed" || i.status === "cancelled").length;
  const total = todo.items.length;

  // Flow view: active items only (completed hidden to save widget space)
  const MAX_VISIBLE = 5;
  const showAll = active.length <= MAX_VISIBLE;
  const visible = showAll ? active : active.slice(0, MAX_VISIBLE);

  const lines: string[] = [];
  lines.push(`┌─ Todo (${done}/${total}) ──────────`);

  for (let i = 0; i < visible.length; i++) {
    const item = visible[i];
    const icon = STATUS_ICONS[item.status] || "○";
    const safe = truncate(item.content, 40);
    const bold = item.status === "in_progress" ? "\x1b[1m" : "";
    const reset = item.status === "in_progress" ? "\x1b[0m" : "";
    lines.push(`│  ${bold}${icon}${reset} ${bold}${safe}${reset}`);
    if (i < visible.length - 1) lines.push(`│  │`);
  }

  if (!showAll) {
    lines.push(`│  ... ${active.length - MAX_VISIBLE} more`);
  }
  lines.push(`└─ /todo for all ${total} items`);

  ui.setWidget("todo", lines);
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  _pi = pi;
  _notify = pi?.ui?.notify?.bind?.(pi?.ui) ?? null;

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

        return { id: String(++_itemIdCounter), content: truncate(sanitized, 200), status };
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

      // Remove duplicate items, keeping only the first occurrence of each unique content.
      // This is consistent with the bridge addItem which also rejects duplicates.
      const seen = new Set<string>();
      items = items.filter(item => {
        if (seen.has(item.content)) {
          const preview = item.content.length > 40 ? item.content.substring(0, 40) + "…" : item.content;
          warnings.push(`Duplicate item: "${preview}" — keeping only first occurrence.`);
          return false;
        }
        seen.add(item.content);
        return true;
      });

      todo = { items, updatedAt: Date.now() };
      renderWidget(ctx);

      // Cancel any pending auto-clear timer to avoid race conditions.
      // This must run unconditionally so that a new non-done list written
      // after an all-done list does not get erroneously auto-cleared.
      if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }

      // Auto-clear when all done: show completed list as notification, then clear widget
      checkAndAutoClear(ctx);

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

      return { content: [{ type: "text", text: summary.join("\n") }], details: { count: items.length, counts, items: items.map(i => ({ content: i.content, status: i.status })) } };
    },
  });

  // ── /todo command ────────────────────────────────────────────────────
  pi.registerCommand("todo", {
    description: "Show the current todo list",
    handler: async (_args, ctx) => {
      const ui = ctx?.ui ?? _pi?.ui;
      if (!ui) return;

      if (todo.items.length === 0) {
        ui.notify("No todo items yet. Use todo_write to create a plan.", "info");
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
        const safeContent = truncate(item.content, 60);
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
        ui.setWidget("todo-detail", undefined);
        detailWidgetActive = false;
        ui.notify(`Todo detail hidden (${done}/${total} done)`, "info");
      } else {
        // Show detail
        ui.setWidget("todo-detail", detailLines);
        detailWidgetActive = true;
        ui.notify(`Todo detail shown (${done}/${total} done). /todo to hide.`, "info");
      }
    },
  });

  // ── session_start: restore widget on resume ─────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Clear any stale auto-clear timer from a previous session
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    // Ensure _pi is alive (may have been nulled by a prior shutdown)
    _pi = _pi ?? pi;

    // Restore state from the most recent todo_write in the session branch
    restoreFromBranch(ctx);
    // Always start with the compact widget (not the detail view)
    clearDetailWidget(ctx);
    renderWidget(ctx);
  });

  // ── session_tree: rebuild state after tree navigation ────────────────
  pi.on("session_tree", async (_event, ctx) => {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    _pi = _pi ?? pi;
    restoreFromBranch(ctx);
    clearDetailWidget(ctx);

    // Auto-clean: remove completed/cancelled items after each interaction
    const doneBefore = todo.items.filter(i => i.status === "completed" || i.status === "cancelled");
    if (doneBefore.length > 0) {
      // Show notification with just-completed items
      const doneList = doneBefore.map(i => `  ${STATUS_ICONS[i.status]} ${i.content}`).join("\n");
      const ui = ctx?.ui ?? _pi?.ui;
      if (ui) {
        ui.notify(`✅ ${doneBefore.length} task(s) done:\n${doneList}`, "info");
      }
      // Remove them from the active list
      todo.items = todo.items.filter(i => i.status !== "completed" && i.status !== "cancelled");
      todo.updatedAt = Date.now();
    }

    renderWidget(ctx);
  });

  // ── session_shutdown: clear widgets, keep state for restore ─────────
  pi.on("session_shutdown", async (_event, ctx) => {
    if (_autoClearTimer !== null) { clearTimeout(_autoClearTimer); _autoClearTimer = null; }
    try {
      _pi?.ui?.setWidget?.("todo", undefined);
      _pi?.ui?.setWidget?.("todo-detail", undefined);
      ctx?.ui?.setWidget?.("todo", undefined);
      ctx?.ui?.setWidget?.("todo-detail", undefined);
    } catch { /* ignore */ }
    detailWidgetActive = false;
    _pi = null;
  });
}
