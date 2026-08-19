/**
 * Tests for the todo flow core integration (TodoStore).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TODO_SESSION_ENTRY_TYPE, TodoStore } from "../todo/lib/store.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

describe("TodoStore", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let notifications: Array<{ message: string; level: string }>;
	let changeCount: number;
	let store: TodoStore;

	function latestPersistedItems(): Array<{ id?: string; content: string; status: string }> | undefined {
		const branch = sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === TODO_SESSION_ENTRY_TYPE) {
				return (entry.data as { items?: Array<{ id?: string; content: string; status: string }> }).items;
			}
		}
		return undefined;
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-todo-test-"));
		sessionManager = SessionManager.create(tempDir);
		notifications = [];
		changeCount = 0;
		store = new TodoStore(sessionManager, {
			onChange: () => {
				changeCount++;
			},
			notify: (message, level) => {
				notifications.push({ message, level });
			},
		});
	});

	afterEach(() => {
		store.onShutdown();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persist excludes programmatic (bridge) items", () => {
		// Simulates: subagent adds a status item, then the model writes its list.
		store.addItem("🔍 subagent task", "pending");
		store.replaceFromModel([{ content: "model task", status: "in_progress" }]);

		// Both are visible in the live store…
		expect(store.getItems()).toHaveLength(2);
		// …but only the model-owned item is persisted.
		const persisted = latestPersistedItems();
		expect(persisted).toHaveLength(1);
		expect(persisted?.[0]).toMatchObject({ content: "model task" });
	});

	it("restore after restart leaves no orphaned programmatic items", () => {
		store.addItem("🔍 subagent task", "pending");
		store.replaceFromModel([{ content: "model task", status: "pending" }]);

		// Simulate a restart: a fresh store over the same session manager.
		const restored = new TodoStore(sessionManager, {
			onChange: () => {},
			notify: () => {},
		});
		restored.onSessionStart();
		const contents = restored.getItems().map((i) => i.content);
		expect(contents).toEqual(["model task"]);
	});

	it("replaces the list on model write and persists a session entry", () => {
		store.replaceFromModel([{ content: "task one" }, { content: "task two", status: "in_progress" }]);

		const items = store.getItems();
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ content: "task one", status: "pending" });
		expect(items[1]).toMatchObject({ content: "task two", status: "in_progress" });
		expect(items[0].id).toBeDefined();

		const persisted = latestPersistedItems();
		expect(persisted).toHaveLength(2);
		expect(changeCount).toBeGreaterThan(0);
	});

	it("does not truncate long content", () => {
		const longContent = `implement the thing: ${"x".repeat(500)}`;
		store.replaceFromModel([{ content: longContent }]);
		expect(store.getItems()[0].content).toBe(longContent);
	});

	it("deduplicates by content and enforces a single in_progress item", () => {
		const { items, warnings } = store.replaceFromModel([
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "in_progress" },
			{ content: "a" },
		]);

		expect(items).toHaveLength(2);
		expect(items.filter((i) => i.status === "in_progress")).toHaveLength(1);
		expect(items.find((i) => i.content === "b")?.status).toBe("in_progress");
		expect(warnings.some((w) => w.startsWith("Duplicate item"))).toBe(true);
		expect(warnings.some((w) => w.startsWith("Auto-fixed"))).toBe(true);
	});

	it("rejects items that sanitize to empty", () => {
		expect(() => store.replaceFromModel([{ content: "\x1b[31m\x1b[0m" }])).toThrow(/empty content/);
	});

	it("preserves programmatic items across model rewrites", () => {
		const progId = store.addItem("subagent: explore repo")!;
		expect(progId).toBeTruthy();

		store.replaceFromModel([{ content: "model task" }]);

		const items = store.getItems();
		expect(items).toHaveLength(2);
		const prog = items.find((i) => i.content === "subagent: explore repo");
		expect(prog?.id).toBe(progId);
	});

	it("bridge updates mark items in_progress and complete with renamed content", () => {
		const id = store.addItem("🔍 run tests")!;
		expect(store.updateItemById(id, "in_progress")).toBe(true);
		expect(store.getItems()[0].status).toBe("in_progress");

		expect(store.updateItemById(id, "completed", "🔍 run tests — ✅ clean (2r)")).toBe(true);
		const item = store.getItems()[0];
		expect(item.status).toBe("completed");
		expect(item.content).toBe("🔍 run tests — ✅ clean (2r)");
	});

	it("bridge rename is rejected on content collision without partial status change", () => {
		const id = store.addItem("first")!;
		store.addItem("second");
		expect(store.updateItemById(id, "completed", "second")).toBe(false);
		const item = store.getItems().find((i) => i.id === id)!;
		expect(item.content).toBe("first");
		expect(item.status).toBe("pending");
	});

	it("model rewrite honors the bridge's in_progress choice for programmatic items", () => {
		const progId = store.addItem("programmatic", "in_progress")!;
		const otherId = store.addItem("other programmatic")!;
		store.updateItemById(otherId, "in_progress");

		store.replaceFromModel([{ content: "model task", status: "in_progress" }]);

		const items = store.getItems();
		expect(items.filter((i) => i.status === "in_progress")).toHaveLength(1);
		// The bridge's latest in_progress choice wins over the model's.
		expect(items.find((i) => i.id === otherId)?.status).toBe("in_progress");
		expect(items.find((i) => i.id === progId)?.status).toBe("pending");
	});

	it("agent_end auto-cleans completed model items but keeps programmatic ones", () => {
		const progId = store.addItem("programmatic", "completed")!;
		store.replaceFromModel([{ content: "done task", status: "completed" }, { content: "open task" }]);

		store.onAgentEnd();

		const items = store.getItems();
		expect(items.find((i) => i.content === "done task")).toBeUndefined();
		expect(items.find((i) => i.content === "open task")).toBeDefined();
		expect(items.find((i) => i.id === progId)).toBeDefined();
		expect(notifications.some((n) => n.message.includes("completed"))).toBe(true);
	});

	it("restores from the persisted session entry on session start", () => {
		store.replaceFromModel([{ content: "restored one" }, { content: "restored two", status: "in_progress" }]);

		const fresh = new TodoStore(sessionManager, {
			onChange: () => {},
			notify: () => {},
		});
		fresh.onSessionStart();

		const items = fresh.getItems();
		expect(items).toHaveLength(2);
		expect(items[1]).toMatchObject({ content: "restored two", status: "in_progress" });
		fresh.onShutdown();
	});

	it("restores an empty list when the branch has no todo entry", () => {
		const fresh = new TodoStore(sessionManager, {
			onChange: () => {},
			notify: () => {},
		});
		fresh.onSessionStart();
		expect(fresh.getItems()).toHaveLength(0);
		fresh.onShutdown();
	});

	it("session tree restore keeps programmatic items and replays bridge mutations", () => {
		store.replaceFromModel([{ content: "model task" }]);
		// Bridge mutations after the model write exist only in memory.
		const items = store.getItems();
		const modelItemId = items[0].id!;
		store.addItem("programmatic");
		store.updateItemById(modelItemId, "completed");

		// Simulate tree navigation: restores from the persisted snapshot (which
		// still says "pending"), then replays the bridge mutation.
		store.onSessionTree();

		const after = store.getItems();
		expect(after.find((i) => i.content === "model task")?.status).toBe("completed");
		expect(after.find((i) => i.content === "programmatic")).toBeDefined();
	});

	it("bridge removals are not resurrected by session tree restore", () => {
		store.replaceFromModel([{ content: "doomed" }]);
		const id = store.getItems()[0].id!;
		store.removeItemById(id);

		store.onSessionTree();
		expect(store.getItems()).toHaveLength(0);
	});

	it("progress items survive tree restores and never persist", () => {
		store.setProgress("agent-1", "running", "npm test");
		store.onSessionTree();
		const progress = store.getProgressItems();
		expect(progress).toHaveLength(1);
		expect(progress[0][0]).toBe("agent-1");
		expect(latestPersistedItems()).toBeUndefined();
	});

	it("updateItemByContent prefers exact match over ambiguous prefix", () => {
		store.replaceFromModel([{ content: "build" }, { content: "build everything" }]);
		expect(store.updateItemByContent("build", "completed")).toBe(true);
		expect(store.getItems().find((i) => i.content === "build")?.status).toBe("completed");
		expect(store.getItems().find((i) => i.content === "build everything")?.status).toBe("pending");
	});
});
