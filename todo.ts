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
  const maxItems = active.length <= 8 ? active.length : 7;
  const lines: string[] = [];
  lines.push(`┌─ Todo (${done}/${total} done) ────────────────`);

  // Show active items first: in_progress, then pending
  const sorted = [...active].sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    return 0;
  });

  for (let i = 0; i < Math.min(sorted.length, maxItems); i++) {
    const item = sorted[i];
    const icon = STATUS_ICONS[item.status] || "○";
    const safeContent = item.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/\n/g, " ");
    if (item.status === "in_progress") {
      lines.push(`│ ${icon} \x1b[1m${safeContent}\x1b[0m`);
    } else {
      lines.push(`│ ${icon} ${safeContent}`);
    }
  }

  if (sorted.length > maxItems) {
    lines.push(`│ ... ${sorted.length - maxItems} more active, /todo for full`);
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

      // Validate and normalize
      const items: TodoItem[] = params.items.map((item: any, i: number) => {
        const content = (item.content || "").trim();
        if (!content) throw new Error(`Todo item ${i + 1} has empty content.`);

        let status: TodoStatus = "pending";
        if (item.status) {
          const s = item.status.trim().toLowerCase();
          if (validStatuses.has(s as TodoStatus)) {
            status = s as TodoStatus;
          }
        }

        return { content: content.substring(0, 200), status };
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
      ];

      // Clear detail widget since todo was updated
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

      // Full list as text — widget is managed by renderWidget() from todo_write
      const fullLines = sorted.map((item, i) =>
        `${i + 1}. ${STATUS_ICONS[item.status]} ${item.content}`
      );
      const text = `=== Todo (${done}/${total}) ===\n\n` + fullLines.join("\n");
      ctx.ui.notify(text, "info");
    },
  });

  // ── session_shutdown: clear widget ───────────────────────────────────
  pi.on("session_shutdown", () => {
    if (_pi) _pi.ui.setWidget("todo", undefined);
  });
}
