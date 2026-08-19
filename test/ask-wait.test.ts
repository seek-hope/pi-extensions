/**
 * Tests for the fork-ask-wait extension's ask_user and wait tools.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { executeAskUser, scheduleWait, stateFor } from "../fork-ask-wait/lib/ask-wait.ts";

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		hasUI: false,
		sessionManager: { getSessionId: () => "test-session" } as unknown as SessionManager,
		ui: {},
		isIdle: () => true,
		sendUserMessage: vi.fn(),
		...overrides,
	} as unknown as ExtensionContext;
}

describe("ask_user", () => {
	it("returns the flagged-assumption fallback when headless", async () => {
		const result = await executeAskUser({ questions: ["q1"] }, makeCtx({ hasUI: false }));
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("ask_user is unavailable");
		expect(text).toContain("[uncertain:inference]");
	});

	it("collects answers consecutively via the UI input dialog", async () => {
		const answers = ["first", "second"];
		const input = vi.fn(async () => answers.shift()!);
		const result = await executeAskUser(
			{ questions: ["q1", "q2"] },
			makeCtx({ hasUI: true, ui: { input } as never }),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(input).toHaveBeenCalledTimes(2);
		expect(text).toContain("Q: q1\nA: first");
		expect(text).toContain("Q: q2\nA: second");
	});

	it("notes dismissed dialogs and keeps asking", async () => {
		const input = vi.fn(async () => undefined);
		const result = await executeAskUser({ questions: ["q1", "q2"] }, makeCtx({ hasUI: true, ui: { input } as never }));
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("(no answer — user dismissed the dialog)");
		expect(input).toHaveBeenCalledTimes(2);
	});
});

describe("wait", () => {
	it("rejects out-of-range durations without clamp", () => {
		const result = scheduleWait(999999, false, makeCtx({ hasUI: false }));
		expect(result.ok).toBe(false);
		expect(result.error).toContain("out of range");
	});

	it("enforces the headless 5-use cap", () => {
		const ctx = makeCtx({ hasUI: false });
		for (let i = 0; i < 5; i++) {
			const r = scheduleWait(1, false, ctx);
			expect(r.ok).toBe(true);
			const state = stateFor(ctx.sessionManager);
			if (state.timer) clearTimeout(state.timer);
			state.headlessCount = i + 1; // keep state deterministic across timers
		}
		const sixth = scheduleWait(1, false, ctx);
		expect(sixth.ok).toBe(false);
		expect(sixth.error).toContain("5 waits per session");
	});

	it("clamps durations above the cap when requested", () => {
		const ctx = makeCtx({ hasUI: false });
		const result = scheduleWait(500, true, ctx);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("capped at 120s");
		const state = stateFor(ctx.sessionManager);
		if (state.timer) clearTimeout(state.timer);
	});
});
