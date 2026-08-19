/**
 * todo_write tool — model-facing entry point for the todo flow.
 */
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { STATUS_ICONS, type TodoStore } from "./store.ts";

const todoWriteSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			content: Type.String({ description: "Task description (short and action-oriented)", minLength: 1 }),
			status: Type.Optional(
				Type.String({ description: "Status: pending (default), in_progress, completed, cancelled" }),
			),
		}),
		{ description: "The complete todo list. Replaces all previous items." },
	),
});

export type TodoWriteInput = Static<typeof todoWriteSchema>;

export function createTodoWriteToolDefinition(
	storeFor: (ctx: ExtensionContext) => TodoStore,
): ToolDefinition<typeof todoWriteSchema, { count: number; counts: Record<string, number>; items: unknown[] }> {
	return {
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
		parameters: todoWriteSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!Array.isArray(params.items)) {
				throw new Error(`Expected items to be an array, got ${typeof params.items}`);
			}

			const store = storeFor(ctx);
			const { items, warnings } = store.replaceFromModel(
				params.items as Array<{ content: string; status?: string }>,
			);

			const counts: Record<string, number> = {};
			for (const item of items) {
				counts[item.status] = (counts[item.status] || 0) + 1;
			}

			const summary =
				items.length === 0
					? ["Todo list cleared."]
					: [
							`Todo list updated (${items.length} items):`,
							...Object.entries(counts).map(([s, n]) => {
								const icon = STATUS_ICONS[s as keyof typeof STATUS_ICONS] || "○";
								return `  ${icon} ${n} ${s.replace("_", " ")}`;
							}),
							...(warnings.length > 0 ? ["", "! warnings:", ...warnings.map((w) => `  ${w}`)] : []),
						];

			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: {
					count: items.length,
					counts,
					items: items.map((i) => ({ id: i.id, content: i.content, status: i.status })),
				},
			};
		},
	};
}
