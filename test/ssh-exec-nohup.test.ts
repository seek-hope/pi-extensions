/**
 * Tests for the ssh_exec foreground path: every command runs under nohup on
 * the remote; fast commands return their output directly, long-running ones
 * are handed to the background poller with a completion notice.
 */

import { describe, expect, it, vi } from "vitest";
import { SshIntegration } from "../ssh/lib/integration.ts";
import { type SshConnection, SshConnectionStore } from "../ssh/lib/store.ts";
import type { SshIntegrationContext as CoreIntegrationContext } from "../ssh/lib/integration.ts";

function makeConn(key: string): SshConnection {
	return {
		key,
		alias: key,
		aliases: new Set([key.toLowerCase()]),
		socket: `/tmp/${key}.sock`,
		sshTarget: `user@${key}`,
		proc: null,
		buf: "",
		pending: new Map(),
		reqId: 0,
		startTime: Date.now(),
		lastUse: Date.now(),
	};
}

/** Unique per-run log path: remoteTasks persist to disk between runs. */
function uniqueLog(): string {
	return `/tmp/pi-fg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`;
}

/** Store with a programmable shellExec — no live SSH host needed. */
class TestStore extends SshConnectionStore {
	responses: string[] = [];
	captured: string[] = [];
	connected = true;
	override async shellExec(_conn: SshConnection, cmd: string, _timeout: number): Promise<string> {
		this.captured.push(cmd);
		return this.responses.shift() ?? "";
	}
	override async isConnected(_key: string, _quick = false): Promise<boolean> {
		return this.connected;
	}
	override async syncFromDisk(): Promise<void> {
		// No disk discovery/pruning in tests: injected connections must survive.
	}
	injectConn(conn: SshConnection): void {
		(this as unknown as { connections: Map<string, SshConnection> }).connections.set(conn.key, conn);
	}
}

function makeIntegration(store: TestStore): SshIntegration {
	const ctx = {
		cwd: "/tmp",
		getUI: () => undefined,
		sendFollowUp: () => {},
		getModel: () => undefined,
		getIntegration: () => undefined,
	} as unknown as CoreIntegrationContext;
	return new SshIntegration(ctx, store);
}

function execTool(integration: SshIntegration) {
	const def = integration.getToolDefinitions().find((d) => d.name === "ssh_exec")!;
	return def;
}

/** Run a tool definition with the full five-argument signature. */
function runTool(tool: ReturnType<typeof execTool>, id: string, params: Record<string, unknown>) {
	return tool.execute(
		id,
		params as never,
		undefined,
		undefined,
		{} as import("../src/core/extensions/types.ts").ExtensionContext,
	);
}

describe("ssh_exec foreground nohup path", () => {
	it("returns fast command output directly (marker stripped)", async () => {
		const store = new TestStore();
		const conn = makeConn("box");
		store.injectConn(conn);
		// startRemoteNohup → PID; waitRemoteProcess: kill -0 says dead; cat returns output with marker
		store.responses = ["PID=4242", "dead", "hello from remote\n__PI_EXIT__0\n"];
		const tool = execTool(makeIntegration(store));
		const result = await runTool(tool, "t1", { host: "box", command: "echo hello" });
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello from remote\n" });
		// The startup wrapper was sent under nohup with a marker echo.
		expect(store.captured[0]).toContain("nohup bash -c");
		expect(store.captured[0]).toContain("__PI_EXIT__");
	});

	it("hands long-running commands to background monitoring with a wait hint", async () => {
		const store = new TestStore();
		const conn = makeConn("box");
		store.injectConn(conn);
		// PID, then kill -0 always alive (window expires), then the poller's cat.
		store.responses = ["PID=777", "alive", "alive", "alive", "alive", "alive"];
		const tool = execTool(makeIntegration(store));
		const result = await runTool(tool, "t1", { host: "box", command: "python train.py", timeout: 5 });
		const text = result.content[0];
		expect(text).toMatchObject({ type: "text" });
		if (text.type !== "text") throw new Error("expected text");
		expect(text.text).toContain("moved to background monitoring");
		expect(text.text).toContain("wait()");
		expect(result.details).toMatchObject({ logPath: expect.any(String), pid: "777" });
		// The process is registered with the poller for completion notification.
		expect(
			(store as unknown as { remoteTasks: Array<{ pid: string | null }> }).remoteTasks.some((t) => t.pid === "777"),
		).toBe(true);
	});

	it("survives single quotes in the command", async () => {
		const store = new TestStore();
		const conn = makeConn("box");
		store.injectConn(conn);
		store.responses = ["PID=9", "dead", "ok\n__PI_EXIT__0\n"];
		const tool = execTool(makeIntegration(store));
		await runTool(tool, "t1", { host: "box", command: 'echo "it\'s fine"' });
		// The escaped wrapper keeps the command's quotes intact.
		expect(store.captured[0]).toContain("it'\\''s fine");
	});

	it("blocks sleep commands as before", async () => {
		const store = new TestStore();
		const conn = makeConn("box");
		store.injectConn(conn);
		const tool = execTool(makeIntegration(store));
		const result = await runTool(tool, "t1", { host: "box", command: "sleep 30" });
		expect(result.details).toMatchObject({ blocked: true });
	});
});

describe("ssh_exec background param", () => {
	it("includes the wait hint in the started message", async () => {
		const store = new TestStore();
		const conn = makeConn("box");
		store.injectConn(conn);
		// spawnRemoteBg: PID echo, then poller cats. Unique command avoids disk dedup.
		store.responses = ["PID=55\n", "done\n"];
		const tool = execTool(makeIntegration(store));
		const result = await runTool(tool, "t1", { host: "box", command: `make train ${Date.now()}`, background: true });
		const text = result.content[0];
		expect(text).toMatchObject({ type: "text" });
		if (text.type !== "text") throw new Error("expected text");
		expect(text.text).toContain("Background task started");
		expect(text.text).toContain("wait()");
	});
});

describe("store.startRemoteNohup / waitRemoteProcess / monitorRunningRemoteTask", () => {
	it("startRemoteNohup parses the pid and escapes the command", async () => {
		const store = new TestStore();
		store.responses = ["PID=1234"];
		const conn = makeConn("box");
		const { logPath, pid } = await store.startRemoteNohup(conn, "echo hi");
		expect(pid).toBe("1234");
		expect(logPath).toMatch(/^\/tmp\/pi-fg-/);
		expect(store.captured[0]).toContain("nohup bash -c 'echo hi; echo \"__PI_EXIT__$?\"'");
	});

	it("waitRemoteProcess strips the marker from the log", async () => {
		const store = new TestStore();
		store.responses = ["dead", "line1\n__PI_EXIT__0\n"];
		const conn = makeConn("box");
		const result = await store.waitRemoteProcess(conn, "1234", "/tmp/x.log", 10_000);
		expect(result).toEqual({ finished: true, output: "line1\n" });
	});

	it("waitRemoteProcess reports unfinished after the window", async () => {
		const store = new TestStore();
		store.responses = ["alive"];
		const conn = makeConn("box");
		const result = await store.waitRemoteProcess(conn, "1234", "/tmp/x.log", 100);
		expect(result.finished).toBe(false);
	});

	it("monitorRunningRemoteTask registers with the poller without restarting", async () => {
		const store = new TestStore();
		const conn = makeConn("box");
		store.injectConn(conn);
		const log = uniqueLog();
		await store.monitorRunningRemoteTask("box", conn, "train", log, "77", "s1");
		expect(
			(store as unknown as { remoteTasks: Array<{ pid: string | null; logPath: string }> }).remoteTasks.some(
				(t) => t.pid === "77" && t.logPath === log,
			),
		).toBe(true);
		// Poller is active for this log path.
		const active = (store as unknown as { pollRemoteActive: Set<string> }).pollRemoteActive;
		expect(active.has(log)).toBe(true);
	});
});

describe("emitRemoteTaskMessage completion guidance", () => {
	it("notifies with the keep-going guidance", async () => {
		const store = new TestStore();
		const listener = vi.fn();
		// Same session id as the monitor call so the targeted notification reaches it.
		store.subscribe(
			{ onRemoteTaskMessage: (lines) => listener(lines), onStatus: () => {}, onNotify: () => {} },
			"s1",
		);
		const conn = makeConn("box");
		store.injectConn(conn);
		// wc -c checks (unchanged, 5x) → kill -0 dead → cat output.
		store.responses = ["0", "0", "0", "0", "0", "dead", "final output\n__PI_EXIT__0\n"];
		await store.monitorRunningRemoteTask("box", conn, "echo x", uniqueLog(), "88", "s1");
		// Poll cadence: 3s + 5s × 4 unchanged checks, then kill -0 and cat.
		await new Promise((r) => setTimeout(r, 30000));
		expect(listener).toHaveBeenCalled();
		const lines = listener.mock.calls[0]?.[0] as string[];
		expect(lines.join("\n")).toContain("keep going");
	}, 60_000);
});
