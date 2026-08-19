/**
 * Extension-level tests for the context extension's file-state features:
 * the prompt-time delta notice (steer) and the write/edit staleness veto.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as SessionManagerImpl } from "@earendil-works/pi-coding-agent";
import forkContext from "../context/index.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	const sent: Array<{ text: string; options?: { deliverAs?: string } }> = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		sendUserMessage: vi.fn((text: string, options?: { deliverAs?: string }) => {
			sent.push({ text, options });
		}),
	} as unknown as ExtensionAPI;
	forkContext(pi);

	const sessionManager = SessionManagerImpl.inMemory();
	const ctx = {
		hasUI: false,
		sessionManager: sessionManager as unknown as SessionManager,
		ui: {},
	} as unknown as ExtensionContext;
	return { handlers, ctx, sent };
}

function toolResultEvent(toolName: string, path: string, text: string) {
	return {
		toolName,
		input: { path },
		content: [{ type: "text", text }],
		isError: false,
	} as never;
}

describe("file-state features", () => {
	it("vetoes a write to a file that changed on disk since the tracked read", async () => {
		const { handlers, ctx } = harness();
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-fs-"));
		const file = join(dir, "a.txt");
		writeFileSync(file, "original");
		try {
			// Model reads the file (tracked), then the disk content changes.
			await handlers.get("tool_result")!(toolResultEvent("read", file, "original"), ctx);
			writeFileSync(file, "changed externally");

			const result = (await handlers.get("tool_call")!(
				{ toolName: "write", input: { path: file, content: "new" } } as never,
				ctx,
			)) as { block?: boolean; reason?: string } | undefined;
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("outdated");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows a write when the tracked content matches disk", async () => {
		const { handlers, ctx } = harness();
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-fs-"));
		const file = join(dir, "b.txt");
		writeFileSync(file, "same");
		try {
			await handlers.get("tool_result")!(toolResultEvent("read", file, "same"), ctx);
			const result = (await handlers.get("tool_call")!(
				{ toolName: "write", input: { path: file, content: "new" } } as never,
				ctx,
			)) as { block?: boolean } | undefined;
			expect(result?.block).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("steers a file-state notice on user input after an external change", async () => {
		const { handlers, ctx, sent } = harness();
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-fs-"));
		const file = join(dir, "c.txt");
		writeFileSync(file, "v1");
		try {
			// Backdate v1 so the external change has a guaranteed-newer mtime.
			const { utimesSync } = await import("node:fs");
			const past = new Date(Date.now() - 60_000);
			utimesSync(file, past, past);
			await handlers.get("tool_result")!(toolResultEvent("read", file, "v1"), ctx);
			writeFileSync(file, "v2-longer-content");
			await handlers.get("input")!({ text: "next prompt" } as never, ctx);
			expect(sent).toHaveLength(1);
			expect(sent[0]!.text).toContain("[file-state]");
			expect(sent[0]!.text).toContain(file);
			expect(sent[0]!.options?.deliverAs).toBe("steer");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
