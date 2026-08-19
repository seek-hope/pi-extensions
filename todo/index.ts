/**
 * todo (pi-ex): the todo flow, migrated from pi-ex core's TodoIntegration.
 *
 * - todo_write tool + bounded main widget + paged /todo detail.
 * - Stale-todo steering reminder on user input (every N user turns).
 * - Pre-compaction refresh: on session_before_compact, cancels the compaction,
 *   runs one refresh turn ("update your todo list"), then re-triggers
 *   compaction on agent_end. One refresh per store-state; failures degrade to
 *   plain compaction.
 *
 * The store persists via session custom entries — the extension runs inside
 * pi-ex's process, so the read-only SessionManager type is widened with a cast
 * (fork-internal convention: runtime object is the real SessionManager).
 */
import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stateFor, type TodoState } from "../shared/todo-state.ts";
import { STATUS_ICONS, type TodoItem } from "./lib/store.ts";
import { createTodoWriteToolDefinition } from "./lib/tool.ts";

/** Item lines in the main widget before the "N more" hint kicks in. */
const MAIN_WIDGET_MAX_ITEMS = 8;
/** User-turn gap before the stale-todo reminder fires. */
const STALE_GAP = 5;

const TODO_COMPACTION_REMINDER = `[system-reminder] Session compaction is about to start: the conversation will be summarized and older messages discarded. Update your todo list to reflect the current state of the work before that happens:
- Mark items you completed as completed.
- Keep unfinished items (reword them if the plan changed).
- Cancel items that are no longer relevant.
Then end your turn — compaction continues automatically.`;

/** Items sorted for display: actionable first (in_progress → pending → done). */
function sortedItems(s: TodoState): TodoItem[] {
	const statusOrder = ["in_progress", "pending", "completed", "cancelled"];
	return s.store
		.getItems()
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const ra = statusOrder.indexOf(a.item.status);
			const rb = statusOrder.indexOf(b.item.status);
			return (ra === -1 ? statusOrder.length : ra) - (rb === -1 ? statusOrder.length : rb) || a.index - b.index;
		})
		.map(({ item }) => item);
}

function mainWidgetItemCap(s: TodoState): number {
	const progressLines = s.store.getProgressItems().length > 0 ? s.store.getProgressItems().length + 2 : 0;
	return Math.max(2, MAIN_WIDGET_MAX_ITEMS - progressLines);
}

function detailPageSize(): number {
	const rows = process.stdout.rows ?? 24;
	return Math.min(25, Math.max(10, Math.floor(rows / 3)));
}

export function renderWidget(ctx: ExtensionContext, s: TodoState): void {
	if (!ctx.hasUI) return;
	if (s.store.isEmpty) {
		clearDetailWidget(ctx, s);
		ctx.ui.setWidget("todo", undefined);
		return;
	}
	if (s.detailWidgetActive) {
		renderDetailPage(ctx, s);
	}
	const items = s.store.getItems();
	const progress = s.store.getProgressItems();
	const done = items.filter((i) => i.status === "completed" || i.status === "cancelled").length;
	const sorted = sortedItems(s);
	const progressLines = progress.length > 0 ? progress.length + 2 : 0;
	const itemCap = Math.max(2, MAIN_WIDGET_MAX_ITEMS - progressLines);
	const shown = sorted.slice(0, itemCap);
	const hidden = sorted.length - shown.length;

	const lines: string[] = [];
	if (items.length > 0) lines.push(`Todo (${done}/${items.length})`);
	for (const item of shown) {
		const icon = STATUS_ICONS[item.status] || "○";
		const bold = item.status === "in_progress" ? "\x1b[1m" : "";
		const reset = item.status === "in_progress" ? "\x1b[0m" : "";
		lines.push(`${bold}${icon} ${item.content}${reset}`);
	}
	if (hidden > 0) lines.push(`… ${hidden} more — /todo for full list`);
	if (progress.length > 0) {
		if (items.length > 0) lines.push("");
		lines.push("Progress");
		for (const [key, prog] of progress) {
			lines.push(`  ◐ [${key}] ${prog.status}: ${prog.content}`);
		}
	}
	ctx.ui.setWidget("todo", lines);
}

function renderDetailPage(ctx: ExtensionContext, s: TodoState): void {
	if (!ctx.hasUI || !s.detailWidgetActive) return;
	const items = s.store.getItems();
	if (items.length === 0) {
		clearDetailWidget(ctx, s);
		return;
	}
	const hidden = sortedItems(s).slice(mainWidgetItemCap(s));
	if (hidden.length === 0) {
		clearDetailWidget(ctx, s);
		return;
	}
	const done = items.filter((i) => i.status === "completed" || i.status === "cancelled").length;
	const pageSize = detailPageSize();
	const pages = Math.max(1, Math.ceil(hidden.length / pageSize));
	s.detailPage = Math.min(s.detailPage, pages);
	const start = (s.detailPage - 1) * pageSize;
	const pageItems = hidden.slice(start, start + pageSize);

	const lines: string[] = [
		`Todo detail (${done}/${items.length} done · ${hidden.length} not shown above) — page ${s.detailPage}/${pages}`,
	];
	for (const item of pageItems) {
		const icon = STATUS_ICONS[item.status] || "○";
		if (item.status === "in_progress") {
			lines.push(`\x1b[1m${icon}\x1b[0m \x1b[1m${item.content}\x1b[0m`);
		} else {
			lines.push(`${icon} ${item.content}`);
		}
	}
	lines.push(
		s.detailPage < pages
			? `(${hidden.length} remaining items · /todo for next page)`
			: `(${hidden.length} remaining items · /todo to close)`,
	);
	ctx.ui.setWidget("todo-detail", () => {
		const container = new Container();
		for (const line of lines) {
			container.addChild(new Text(line, 1, 0));
		}
		return container;
	});
}

function clearDetailWidget(ctx: ExtensionContext, s: TodoState): void {
	s.detailWidgetActive = false;
	s.detailPage = 1;
	if (ctx.hasUI) ctx.ui.setWidget("todo-detail", undefined);
}

export function toggleDetailWidget(ctx: ExtensionContext, s: TodoState): void {
	if (!ctx.hasUI) return;
	const items = s.store.getItems();
	if (items.length === 0) {
		ctx.ui.notify("No todo items yet. Use todo_write to create a plan.", "info");
		return;
	}
	const hidden = sortedItems(s).slice(mainWidgetItemCap(s));
	if (hidden.length === 0) {
		ctx.ui.notify(`All ${items.length} item(s) are already visible in the todo widget.`, "info");
		return;
	}
	const pageSize = detailPageSize();
	const pages = Math.max(1, Math.ceil(hidden.length / pageSize));
	if (!s.detailWidgetActive) {
		s.detailWidgetActive = true;
		s.detailPage = 1;
	} else {
		s.detailPage++;
		if (s.detailPage > pages) {
			clearDetailWidget(ctx, s);
			ctx.ui.notify("Todo detail hidden", "info");
			return;
		}
	}
	renderDetailPage(ctx, s);
}

export function staleWarning(s: TodoState): string | null {
	if (s.userTurnCount - s.lastActivityTurn < STALE_GAP) return null;
	if (s.lastStaleWarnTurn === s.userTurnCount) return null;
	const stale = s.store.getModelItems().filter((i) => i.status === "pending" || i.status === "in_progress");
	if (stale.length === 0) return null;
	const staleFor = s.userTurnCount - s.lastActivityTurn;
	s.lastStaleWarnTurn = s.userTurnCount;
	s.lastActivityTurn = s.userTurnCount;
	const names = stale.map((i) => `"${i.content.substring(0, 40)}${i.content.length > 40 ? "…" : ""}"`).join(", ");
	return (
		`Your todo list has not been updated for the last ${staleFor} user inputs. ` +
		`The following items are still pending or in progress: ${names}. ` +
		`Review them and cancel any that are no longer relevant, or update their status.`
	);
}

export function todoState(ctx: ExtensionContext): TodoState {
	const s = stateFor(ctx);
	s.onStoreChange = (c, st) => renderWidget(c, st);
	return s;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(createTodoWriteToolDefinition((ctx) => todoState(ctx).store));

	pi.registerCommand("todo", {
		description: "Page through todo items beyond the main widget",
		handler: async (_args, ctx) => {
			toggleDetailWidget(ctx, todoState(ctx));
		},
	});

	// Stale-todo reminder: count real user inputs only (machine follow-ups
	// do not advance the clock), steer the warning into the current turn.
	pi.on("input", (_event, ctx) => {
		const s = todoState(ctx);
		s.userTurnCount++;
		const warning = staleWarning(s);
		if (warning) {
			pi.sendUserMessage(warning, { deliverAs: "steer" });
		}
	});

	// Pre-compaction refresh: cancel the compaction, run one refresh turn,
	// then re-trigger compaction when that turn ends. Once per store state;
	// failures degrade to plain compaction on the next trigger.
	pi.on("session_before_compact", (_event, ctx) => {
		const s = todoState(ctx);
		if (s.refreshActive || s.retriggerCompaction) return;
		if (s.lastRefreshedAtTurn === s.lastActivityTurn) return;
		const items = s.store.getModelItems();
		if (items.length === 0 || !items.some((i) => i.status !== "completed")) return;
		s.refreshActive = true;
		s.retriggerCompaction = true;
		s.lastRefreshedAtTurn = s.lastActivityTurn;
		pi.sendUserMessage(TODO_COMPACTION_REMINDER, { deliverAs: "followUp" });
		return { cancel: true };
	});

	pi.on("agent_end", (_event, ctx) => {
		const s = todoState(ctx);
		if (s.retriggerCompaction) {
			s.retriggerCompaction = false;
			s.refreshActive = false;
			ctx.compact({});
		}
	});

	pi.on("session_start", (_event, ctx) => {
		const s = todoState(ctx);
		clearDetailWidget(ctx, s);
		s.store.onSessionStart();
	});
	pi.on("agent_settled", (_event, ctx) => {
		todoState(ctx).store.onAgentEnd();
	});
	pi.on("session_tree", (_event, ctx) => {
		const s = todoState(ctx);
		clearDetailWidget(ctx, s);
		s.store.onSessionTree();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const s = todoState(ctx);
		s.store.onShutdown();
		if (ctx.hasUI) {
			ctx.ui.setWidget("todo", undefined);
			ctx.ui.setWidget("todo-detail", undefined);
		}
		s.detailWidgetActive = false;
	});
}
