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
  if (todo.items.length === 0) {
    _pi.ui.setWidget("todo", undefined);
    return;
  }

  const total = todo.items.length;
  const done = todo.items.filter(i => i.status === "completed" || i.status === "cancelled").length;
  const active = todo.items.find(i => i.status === "in_progress");

  const lines: string[] = [];
  lines.push(`┌─ Todo (${done}/${total}) ──────────────────────────`);

  for (const item of todo.items) {
    const icon = STATUS_ICONS[item.status] || "○";
    // Strip control characters from item content to prevent terminal injection
    const safeContent = item.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/\n/g, " ");
    if (item.status === "in_progress") {
      lines.push(`│ ${icon} \x1b[1m${safeContent}\x1b[0m`);
    } else if (item.status === "completed") {
      lines.push(`│ ${icon} \x1b[2m${safeContent}\x1b[0m`);
    } else if (item.status === "cancelled") {
      lines.push(`│ ${icon} \x1b[2m\x1b[9m${safeContent}\x1b[0m`);
    } else {
      lines.push(`│ ${icon} ${safeContent}`);
    }
    if (lines.length >= 11) break; // 10 items max (header + 9 items + summary)
  }

  if (todo.items.length > 10) {
    lines.push(`│ ... (${todo.items.length - 10} more, /todo for full list)`);
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
    promptGuidelines: [
      "Use todo_write BEFORE starting complex multi-step tasks to create a plan.",
      "Mark items as in_progress when you start working on them, completed when done.",
      "Only ONE item in_progress at a time. Finish or pause before starting another.",
      "If the plan changes, update the todo list — add, remove, or reorder items as needed.",
      "At the end of a session, all items should be completed or cancelled.",
      "Keep item descriptions short and action-oriented (e.g., 'Fix login bug' not 'Work on auth').",
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

      const lines: string[] = [];
      for (const item of todo.items) {
        const icon = STATUS_ICONS[item.status] || "○";
        lines.push(`${icon} [${item.status}] ${item.content}`);
      }

      ctx.ui.setWidget("todo-detail", lines.map(l => `│ ${l}`).slice(0, 15));
      if (lines.length > 15) {
        ctx.ui.notify(`${lines.length - 15} more items not shown.`, "info");
      }
    },
  });

  // ── session_shutdown: clear widget ───────────────────────────────────
  pi.on("session_shutdown", () => {
    if (_pi) _pi.ui.setWidget("todo", undefined);
  });
}
