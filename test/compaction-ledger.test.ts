/**
 * Tests for the action ledger extractor (compaction/ledger.ts).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { emptyLedger, extractLedgerActions, renderLedger } from "../context/lib/ledger.ts";

function assistantWithCalls(
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): AgentMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", ...c })),
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AgentMessage;
}

function toolResult(toolCallId: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "x",
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp: Date.now(),
	} as AgentMessage;
}

describe("extractLedgerActions", () => {
	it("extracts file edits/writes with status from paired results", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "edit", arguments: { path: "src/a.ts" } },
				{ id: "c2", name: "write", arguments: { path: "src/b.ts" } },
			]),
			toolResult("c1"),
			toolResult("c2", true),
		]);

		expect(ledger.files).toEqual([
			{ type: "edit", path: "src/a.ts", status: "ok" },
			{ type: "write", path: "src/b.ts", status: "error" },
		]);
	});

	it("dedups files by path keeping the latest action", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([{ id: "c1", name: "write", arguments: { path: "a.ts" } }]),
			toolResult("c1"),
			assistantWithCalls([{ id: "c2", name: "edit", arguments: { path: "a.ts" } }]),
			toolResult("c2"),
		]);
		expect(ledger.files).toEqual([{ type: "edit", path: "a.ts", status: "ok" }]);
	});

	it("records commands and detects git commits", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "bash", arguments: { command: "npm test" } },
				{ id: "c2", name: "bash", arguments: { command: 'git commit -m "fix bug"' } },
			]),
			toolResult("c1"),
			toolResult("c2"),
		]);
		expect(ledger.commands).toEqual([{ type: "command", command: "npm test", status: "ok" }]);
		expect(ledger.commits).toEqual([{ type: "commit", message: "fix bug", status: "ok" }]);
	});

	it("records subagent operations", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "subagent_spawn", arguments: { task: "explore repo" } },
				{ id: "c2", name: "subagent_merge", arguments: { id: "sa-1" } },
			]),
			toolResult("c1"),
			toolResult("c2"),
		]);
		expect(ledger.subagents).toEqual([
			{ type: "subagent", id: "explore repo", action: "spawn", status: "ok" },
			{ type: "subagent", id: "sa-1", action: "merge", status: "ok" },
		]);
	});

	it("merges with the previous ledger (cumulative across compactions)", () => {
		const prev = emptyLedger();
		prev.files.push({ type: "edit", path: "old.ts", status: "ok" });
		prev.commands.push({ type: "command", command: "old cmd", status: "ok" });

		const ledger = extractLedgerActions(
			[assistantWithCalls([{ id: "c1", name: "edit", arguments: { path: "new.ts" } }]), toolResult("c1")],
			prev,
		);
		expect(ledger.files.map((f) => f.path)).toEqual(["old.ts", "new.ts"]);
		expect(ledger.commands.map((c) => c.command)).toEqual(["old cmd"]);
	});

	it("accepts file_path as an alias for path", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "edit", arguments: { file_path: "src/a.ts" } },
				{ id: "c2", name: "write", arguments: { file_path: "src/b.ts" } },
			]),
			toolResult("c1"),
			toolResult("c2"),
		]);
		expect(ledger.files).toEqual([
			{ type: "edit", path: "src/a.ts", status: "ok" },
			{ type: "write", path: "src/b.ts", status: "ok" },
		]);
	});

	it("annotates non-zero bash exits as exit N instead of (failed)", () => {
		const exitResult = (toolCallId: string): AgentMessage =>
			({
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "some output\n\nCommand exited with code 1" }],
				isError: true,
				timestamp: Date.now(),
			}) as AgentMessage;
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "bash", arguments: { command: "grep foo bar.txt" } },
				{ id: "c2", name: "bash", arguments: { command: "npm test" } },
			]),
			exitResult("c1"),
			toolResult("c2", true), // tool-level error, no exit code in text
		]);
		expect(ledger.commands[0]).toEqual({
			type: "command",
			command: "grep foo bar.txt",
			status: "error",
			exitCode: 1,
		});
		expect(ledger.commands[1]).toEqual({ type: "command", command: "npm test", status: "error" });
	});

	it("caps commands at 50", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 60; i++) {
			messages.push(assistantWithCalls([{ id: `c${i}`, name: "bash", arguments: { command: `cmd ${i}` } }]));
			messages.push(toolResult(`c${i}`));
		}
		const ledger = extractLedgerActions(messages);
		expect(ledger.commands).toHaveLength(50);
		expect(ledger.commands[49].command).toBe("cmd 59");
	});

	it("ignores non-ledger tools and in-flight calls are recorded with unknown status", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "read", arguments: { path: "a.ts" } },
				{ id: "c2", name: "edit", arguments: { path: "b.ts" } },
			]),
			toolResult("c1"),
			// c2 has no result (in-flight)
		]);
		// In-flight calls have no outcome yet — never claim "ok".
		expect(ledger.files).toEqual([{ type: "edit", path: "b.ts", status: "unknown" }]);
	});
});

describe("renderLedger", () => {
	it("renders every list with status icons, newest last", () => {
		const section = renderLedger({
			files: [
				{ type: "write", path: "a.ts", status: "ok" },
				{ type: "edit", path: "b.ts", status: "error" },
				{ type: "edit", path: "c.ts", status: "unknown" },
			],
			commands: [
				{ type: "command", command: "npm test", status: "error", exitCode: 1 },
				{ type: "command", command: "npm run check", status: "ok", exitCode: 0 },
			],
			commits: [{ type: "commit", message: "fix: thing", status: "ok", exitCode: 0 }],
			subagents: [{ type: "subagent", id: "sa-1", action: "merge", status: "ok" }],
		});
		expect(section).toContain("### Files Modified");
		expect(section).toContain("✓ a.ts (write)");
		expect(section).toContain("✗ b.ts (edit)");
		expect(section).toContain("? c.ts (edit)");
		expect(section).toContain("✗ `npm test` (exit 1)");
		expect(section).toContain("✓ `npm run check` (exit 0)");
		expect(section).toContain("✓ fix: thing");
		expect(section).toContain("✓ sa-1 (merge)");
		// newest last
		expect(section.indexOf("a.ts")).toBeLessThan(section.indexOf("c.ts"));
	});

	it("caps each list to the most recent entries and notes the total", () => {
		const files = Array.from({ length: 20 }, (_, i) => ({
			type: "edit" as const,
			path: `f${i}.ts`,
			status: "ok" as const,
		}));
		const section = renderLedger({ files, commands: [], commits: [], subagents: [] }, { files: 5 });
		expect(section).toContain("### Files Modified (latest 5 of 20)");
		expect(section).toContain("f19.ts");
		expect(section).not.toContain("f14.ts");
	});

	it("returns an empty string for an empty ledger", () => {
		expect(renderLedger(emptyLedger())).toBe("");
	});

	it("flattens multi-line commands onto one line", () => {
		const section = renderLedger({
			files: [],
			commands: [{ type: "command", command: "npm run check &&\nnpm test", status: "ok", exitCode: 0 }],
			commits: [],
			subagents: [],
		});
		expect(section).toContain("`npm run check && npm test`");
		expect(section).not.toContain("\n\nnpm");
	});
});
