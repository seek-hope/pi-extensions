/**
 * Tests for the todo extension: bounded main widget, paged /todo
 * detail, and the stale-todo reminder. Adapted from pi-ex's
 * todo-widget.test.ts to the extension shape (state bus + exported render).
 */
import { describe, expect, it } from "vitest";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as SessionManagerImpl } from "@earendil-works/pi-coding-agent";
import { renderWidget, staleWarning, toggleDetailWidget, todoState } from "../todo/index.ts";

interface WidgetCall {
	key: string;
	content: string[] | ((tui: never, theme: never) => { children?: unknown[] }) | undefined;
}

function makeCtx(items: Array<{ content: string; status: string }>) {
	const widgets: WidgetCall[] = [];
	const notifications: string[] = [];
	const sessionManager = SessionManagerImpl.inMemory();
	const ctx = {
		hasUI: true,
		sessionManager: sessionManager as unknown as SessionManager,
		ui: {
			setWidget: (key: string, content: WidgetCall["content"]) => {
				widgets.push({ key, content });
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
	const state = todoState(ctx);
	state.onStoreChange = (c, s) => renderWidget(c, s);
	if (items.length > 0) {
		state.store.replaceFromModel(items);
	}
	return { ctx, state, widgets, notifications };
}

function linesOf(call: WidgetCall): string[] {
	if (Array.isArray(call.content)) return call.content;
	if (typeof call.content === "function") {
		const component = call.content(undefined as never, undefined as never);
		return ((component as { children?: Array<{ text?: string }> }).children ?? []).map((c) => c.text ?? "");
	}
	return [];
}

function mainWidgetLines(widgets: WidgetCall[]): string[] {
	const call = [...widgets].reverse().find((w) => w.key === "todo");
	return call ? linesOf(call) : [];
}

describe("todo stale warning", () => {
	it("reports the real staleness gap, not 0", () => {
		const { state } = makeCtx([{ content: "task A", status: "pending" }]);
		state.userTurnCount = 7;
		expect(staleWarning(state)).toContain("7 user inputs");
	});

	it("respects the gap threshold", () => {
		const { state } = makeCtx([{ content: "task A", status: "pending" }]);
		state.userTurnCount = 4;
		expect(staleWarning(state)).toBeNull();
	});

	it("returns null when nothing is pending or in progress", () => {
		const { state } = makeCtx([{ content: "task A", status: "completed" }]);
		state.userTurnCount = 10;
		expect(staleWarning(state)).toBeNull();
	});

	it("warns once, then stays quiet for another grace period", () => {
		const { state } = makeCtx([{ content: "task A", status: "pending" }]);
		state.userTurnCount = 6;
		expect(staleWarning(state)).toContain("6 user inputs");
		state.userTurnCount = 8;
		expect(staleWarning(state)).toBeNull();
		state.userTurnCount = 11;
		expect(staleWarning(state)).toContain("5 user inputs");
	});

	it("never fires when the list has always been empty", () => {
		const { state } = makeCtx([]);
		for (let turn = 1; turn <= 20; turn++) {
			state.userTurnCount = turn;
			expect(staleWarning(state)).toBeNull();
		}
	});
});

describe("todo main widget", () => {
	it("bounds the list and hints at hidden items", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({ content: `task ${i + 1}`, status: "pending" }));
		const { widgets } = makeCtx(items);
		const lines = mainWidgetLines(widgets);
		expect(lines[0]).toBe("Todo (0/12)");
		expect(lines.some((l) => l.includes("more — /todo for full list"))).toBe(true);
		expect(lines.length).toBeLessThan(12 + 2);
	});

	it("orders in_progress before pending before done", () => {
		const { widgets } = makeCtx([
			{ content: "done task", status: "completed" },
			{ content: "active task", status: "in_progress" },
			{ content: "later task", status: "pending" },
		]);
		const lines = mainWidgetLines(widgets);
		expect(lines[1]).toContain("active task");
		expect(lines[2]).toContain("later task");
		expect(lines[3]).toContain("done task");
	});

	it("clears the widget when the list empties", () => {
		const { ctx, state, widgets } = makeCtx([{ content: "task A", status: "pending" }]);
		state.store.replaceFromModel([]);
		const last = widgets[widgets.length - 1]!;
		expect(last.key).toBe("todo");
		expect(last.content).toBeUndefined();
	});
});

describe("todo detail paging", () => {
	it("pages through hidden items and closes after the last page", () => {
		const items = Array.from({ length: 40 }, (_, i) => ({ content: `task ${i + 1}`, status: "pending" }));
		const { ctx, widgets, notifications } = makeCtx(items);
		toggleDetailWidget(ctx, todoState(ctx));
		const first = [...widgets].reverse().find((w) => w.key === "todo-detail");
		expect(first).toBeDefined();
		expect(linesOf(first!)[0]).toContain("page 1/");
		// Cycle until it closes (a notify marks the close).
		for (let i = 0; i < 10 && !notifications.includes("Todo detail hidden"); i++) {
			toggleDetailWidget(ctx, todoState(ctx));
		}
		expect(notifications).toContain("Todo detail hidden");
	});
});
