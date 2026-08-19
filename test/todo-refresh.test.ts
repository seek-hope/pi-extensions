/**
 * todo pre-compaction refresh flow: session_before_compact cancels and
 * arms a refresh turn; agent_end re-triggers the compaction. Once per store
 * state.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as SessionManagerImpl } from "@earendil-works/pi-coding-agent";
import forkTodo from "../todo/index.ts";
import { stateFor } from "../shared/todo-state.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	const sent: Array<{ text: string; options?: unknown }> = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		sendUserMessage: vi.fn((text: string, options?: unknown) => {
			sent.push({ text, options });
		}),
	} as unknown as ExtensionAPI;
	forkTodo(pi);

	const sessionManager = SessionManagerImpl.inMemory();
	const compacts: unknown[] = [];
	const ctx = {
		hasUI: false,
		sessionManager: sessionManager as unknown as SessionManager,
		ui: {},
		compact: vi.fn((opts: unknown) => compacts.push(opts)),
	} as unknown as ExtensionContext;
	return { handlers, ctx, sent, compacts };
}

describe("todo pre-compaction refresh", () => {
	it("cancels compaction, sends the reminder, and re-triggers on agent_end", () => {
		const { handlers, ctx, sent, compacts } = harness();
		stateFor(ctx).store.replaceFromModel([{ content: "task A", status: "in_progress" }]);

		const beforeCompact = handlers.get("session_before_compact")!;
		const result = beforeCompact({} as never, ctx);
		expect((result as { cancel?: boolean }).cancel).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.text).toContain("Session compaction is about to start");

		handlers.get("agent_end")!({} as never, ctx);
		expect(compacts).toHaveLength(1);
	});

	it("does not refresh twice for the same store state", () => {
		const { handlers, ctx, sent } = harness();
		stateFor(ctx).store.replaceFromModel([{ content: "task A", status: "in_progress" }]);
		const beforeCompact = handlers.get("session_before_compact")!;
		expect((beforeCompact({} as never, ctx) as { cancel?: boolean }).cancel).toBe(true);
		handlers.get("agent_end")!({} as never, ctx);
		// Second compaction attempt for the unchanged store: no cancel.
		expect(beforeCompact({} as never, ctx)).toBeUndefined();
		expect(sent).toHaveLength(1);
	});

	it("lets compaction through when there is nothing unfinished", () => {
		const { handlers, ctx } = harness();
		stateFor(ctx).store.replaceFromModel([{ content: "task A", status: "completed" }]);
		expect(handlers.get("session_before_compact")!({} as never, ctx)).toBeUndefined();
	});
});
