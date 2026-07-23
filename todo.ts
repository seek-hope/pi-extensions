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

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface TodoItem {
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

// ── helpers ─────────────────────────────────────────────────────────────────

function renderWidget(ctx?: any): void {
  const ui = ctx?.ui ?? _pi?.ui;
  if (!ui) return;

  const active = todo.items.filter(i => i.status === "pending" || i.status === "in_progress");
  if (active.length === 0) {
    ui.setWidget("todo", undefined);
    return;
  }

  const total = todo.items.length;
  const done = todo.items.filter(i => i.status === "completed" || i.status === "cancelled").length;

  // Show active items first: in_progress, then pending
  const sorted = [...active].sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    return 0;
  });

  const limit = Math.min(sorted.length, 7);
  const lines: string[] = [];
  lines.push(`┌─ Todo (${done}/${total} done) ────────────────`);

  for (let i = 0; i < limit; i++) {
    const item = sorted[i];
    const icon = STATUS_ICONS[item.status] || "○";
    // Strip control chars (including CR, excluding TAB/LF), then flatten whitespace
    const safeContent = item.content
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
      .replace(/\t/g, " ")
      .replace(/\n/g, " ");
    if (item.status === "in_progress") {
      lines.push(`│ ${icon} \x1b[1m${safeContent}\x1b[0m`);
    } else {
      lines.push(`│ ${icon} ${safeContent}`);
    }
  }

  const remaining = sorted.length - limit;
  if (remaining > 0) {
    lines.push(`│ ... ${remaining} more active, /todo for full`);
  }
  lines.push(`└──────────────────────────────────────────`);

  ui.setWidget("todo", lines);
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  _pi = pi;

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
        content: Type.String({ description: "Task description (short and action-oriented)" }),
        status: Type.Optional(Type.String({ description: "Status: pending (default), in_progress, completed, cancelled" })),
      }), { description: "The complete todo list. Replaces all previous items." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const validStatuses = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);
      const warnings: string[] = [];

      // Validate and normalize
      const items: TodoItem[] = params.items.map((item: any, i: number) => {
        const content = (item.content || "").trim();
        if (!content) throw new Error(`Todo item ${i + 1} has empty content.`);

        let status: TodoStatus = "pending";
        if (item.status) {
          const s = item.status.trim().toLowerCase();
          if (validStatuses.has(s as TodoStatus)) {
            status = s as TodoStatus;
          } else {
            warnings.push(`Item ${i + 1}: invalid status "${item.status}" → defaulting to "pending"`);
          }
        }

        const truncated = content.length > 200;
        return { content: content.substring(0, 200) + (truncated ? "…" : ""), status };
      });

      // Enforce: only one in_progress
      const inProgress = items.filter(i => i.status === "in_progress");
      if (inProgress.length > 1) {
        // Auto-fix: keep the last one as in_progress, demote the rest to pending
        for (let i = 0; i < items.length; i++) {
          if (items[i].status === "in_progress" && items[i] !== inProgress[inProgress.length - 1]) {
            items[i].status = "pending";
          }
        }
      }

      todo = { items, updatedAt: Date.now() };
      renderWidget(ctx);

      // Count by status for response
      const counts: Record<string, number> = {};
      for (const item of items) { counts[item.status] = (counts[item.status] || 0) + 1; }

      const summary = [
        `Todo list updated (${items.length} items):`,
        ...Object.entries(counts).map(([s, n]) => {
          const icon = STATUS_ICONS[s as TodoStatus] || "○";
          return `  ${icon} ${n} ${s.replace("_", " ")}`;
        }),
        ...(warnings.length > 0 ? ["", "⚠ warnings:", ...warnings.map(w => `  ${w}`)] : []),
      ];

      // Clear detail widget since todo was updated
      detailWidgetActive = false;
      ctx.ui?.setWidget?.("todo-detail", undefined);

      return { content: [{ type: "text", text: summary.join("\n") }], details: { count: items.length, counts, items: items.map(i => ({ content: i.content, status: i.status })) } };
    },
  });

  // ── /todo command ────────────────────────────────────────────────────
  pi.registerCommand("todo", {
    description: "Show the current todo list",
    handler: async (_args, ctx) => {
      if (todo.items.length === 0) {
        ctx.ui.notify("No todo items yet. Use todo_write to create a plan.", "info");
        return;
      }

      const statusOrder: TodoStatus[] = ["in_progress", "pending", "completed", "cancelled"];
      const total = todo.items.length;
      const done = todo.items.filter(i => i.status === "completed" || i.status === "cancelled").length;

      const sorted = [...todo.items].sort((a, b) => {
        return statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
      });

      // Build detail widget lines
      const detailLines: string[] = [];
      detailLines.push(`┌─ Todo detail (${done}/${total} done) ─────────────`);
      for (const item of sorted) {
        const icon = STATUS_ICONS[item.status];
        const safeContent = item.content
          .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
          .replace(/\t/g, " ")
          .replace(/\n/g, " ");
        if (item.status === "in_progress") {
          detailLines.push(`│ ${icon} \x1b[1m${safeContent}\x1b[0m`);
        } else {
          detailLines.push(`│ ${icon} ${safeContent}`);
        }
      }
      detailLines.push(`└──────────────────────────────────────────`);
      detailLines.push(`(${total} items · /todo to toggle)`);

      if (detailWidgetActive) {
        // Toggle off
        ctx.ui.setWidget("todo-detail", undefined);
        detailWidgetActive = false;
        ctx.ui.notify(`Todo detail hidden (${done}/${total} done)`, "info");
      } else {
        // Show detail
        ctx.ui.setWidget("todo-detail", detailLines);
        detailWidgetActive = true;
        ctx.ui.notify(`Todo detail shown (${done}/${total} done). /todo to hide.`, "info");
      }
    },
  });

  // ── session_start: restore widget on resume ─────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Restore state from last todo_write result
    try {
      const branch = (ctx as any).sessionManager?.getBranch?.();
      if (Array.isArray(branch)) {
        for (const entry of branch) {
          if (entry?.type !== "message") continue;
          const details = entry?.message?.details as { items?: TodoItem[] } | undefined;
          if (details?.items?.length) todo = { items: details.items, updatedAt: Date.now() };
        }
      }
    } catch { /* best effort — sessionManager may not be available */ }
    detailWidgetActive = false;
    renderWidget(ctx);
  });

  // ── session_tree: rebuild state after tree navigation ────────────────
  pi.on("session_tree", async (_event, ctx) => {
    todo = { items: [], updatedAt: 0 };
    try {
      const branch = (ctx as any).sessionManager?.getBranch?.();
      if (Array.isArray(branch)) {
        for (const entry of branch) {
          if (entry?.type !== "message") continue;
          const details = entry?.message?.details as { items?: TodoItem[] } | undefined;
          if (details?.items?.length) todo = { items: details.items, updatedAt: Date.now() };
        }
      }
    } catch { /* best effort */ }
    detailWidgetActive = false;
    renderWidget(ctx);
  });

  // ── session_shutdown: clear widgets and references ───────────────────
  pi.on("session_shutdown", () => {
    try {
      _pi?.ui?.setWidget?.("todo", undefined);
      _pi?.ui?.setWidget?.("todo-detail", undefined);
    } catch { /* ignore */ }
    detailWidgetActive = false;
    todo = { items: [], updatedAt: 0 };
    _pi = null;
  });
}
