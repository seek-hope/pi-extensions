/**
 * Tests for the SSH core integration: argument parsing, timeout handling,
 * tool-call gating, and the persistent-shell marker protocol.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SshIntegration } from "../ssh/lib/integration.ts";
import {
	connKey,
	parseSshArgs,
	type SshConnection,
	SshConnectionStore,
	shellEscapeDQ,
} from "../ssh/lib/store.ts";
import type { SshIntegrationContext as CoreIntegrationContext } from "../ssh/lib/integration.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { timeoutToMs } from "@earendil-works/pi-coding-agent";

describe("parseSshArgs", () => {
	it("parses user@host", () => {
		const p = parseSshArgs("alice@example.com")!;
		expect(p.user).toBe("alice");
		expect(p.hostname).toBe("example.com");
		expect(p.port).toBe(22);
		expect(p.command).toBe("");
	});

	it("parses user@host with a command", () => {
		const p = parseSshArgs("alice@example.com ls -la /tmp")!;
		expect(p.user).toBe("alice");
		expect(p.hostname).toBe("example.com");
		expect(p.command).toBe("ls -la /tmp");
	});

	it("parses -p PORT user@host", () => {
		const p = parseSshArgs("-p 2222 bob@example.com")!;
		expect(p.port).toBe(2222);
		expect(p.user).toBe("bob");
		expect(p.hostname).toBe("example.com");
	});

	it("parses combined -pPORT syntax", () => {
		const p = parseSshArgs("-p2222 bob@example.com")!;
		expect(p.port).toBe(2222);
	});

	it("parses user@host:port", () => {
		const p = parseSshArgs("bob@example.com:2222")!;
		expect(p.hostname).toBe("example.com");
		expect(p.port).toBe(2222);
	});

	it("parses bracketed IPv6 with port", () => {
		const p = parseSshArgs("bob@[::1]:2222 uptime")!;
		expect(p.hostname).toBe("[::1]");
		expect(p.port).toBe(2222);
		expect(p.command).toBe("uptime");
	});

	it("returns null without a hostname", () => {
		expect(parseSshArgs("-p 2222")).toBeNull();
	});

	it("parses -J jump host (split and combined forms)", () => {
		const a = parseSshArgs("-J root@bastion alice@internal")!;
		expect(a.jump).toBe("root@bastion");
		expect(a.user).toBe("alice");
		expect(a.hostname).toBe("internal");

		const b = parseSshArgs("-Jroot@bastion alice@internal uptime")!;
		expect(b.jump).toBe("root@bastion");
		expect(b.command).toBe("uptime");
	});

	it("no jump when absent", () => {
		expect(parseSshArgs("alice@example.com")!.jump).toBeUndefined();
	});
});

describe("connKey with jump hosts", () => {
	it("distinguishes direct vs jumped connections to the same endpoint", () => {
		const direct = connKey("zgy", "10.0.0.5", 22);
		const jumped = connKey("zgy", "10.0.0.5", 22, "root@vps");
		expect(direct).not.toBe(jumped);
		expect(jumped).toContain("zgy@10.0.0.5:22");
		expect(jumped).toContain("via");
	});

	it("slugifies jump specs for socket filenames", () => {
		const key = connKey("zgy", "10.0.0.5", 22, "root@149.33.12.246");
		expect(key).toBe("zgy@10.0.0.5:22+via+root_149.33.12.246");
		expect(key).not.toContain(" ");
	});
});

describe("timeoutToMs", () => {
	it("bare numbers default to SECONDS across tools", () => {
		expect(timeoutToMs(30)).toBe(30_000);
		expect(timeoutToMs(300)).toBe(300_000);
		expect(timeoutToMs(0.5)).toBe(500);
	});

	it("suffixed strings parse with explicit units", () => {
		expect(timeoutToMs("500ms")).toBe(500);
		expect(timeoutToMs("30s")).toBe(30_000);
		expect(timeoutToMs("10m")).toBe(600_000);
		expect(timeoutToMs("2h")).toBe(7_200_000);
		expect(timeoutToMs("1.5s")).toBe(1500);
		expect(timeoutToMs("30")).toBe(30_000); // bare number string = seconds
	});

	it("rejects zero, negatives, garbage, and non-finite values", () => {
		expect(() => timeoutToMs(0)).toThrow();
		expect(() => timeoutToMs(-5)).toThrow();
		expect(() => timeoutToMs(Number.NaN)).toThrow();
		expect(() => timeoutToMs(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => timeoutToMs("abc")).toThrow();
		expect(() => timeoutToMs("30x")).toThrow();
	});

	it("rejects timeouts beyond the setTimeout ceiling", () => {
		expect(() => timeoutToMs(25 * 3600)).not.toThrow();
		expect(() => timeoutToMs(60_000 * 3600)).toThrow(/maximum/);
	});
});

describe("shellEscapeDQ", () => {
	it("escapes double quotes, dollars, backticks, and backslashes", () => {
		expect(shellEscapeDQ('a"b$c`d`\\e')).toBe('a\\"b\\$c\\`d\\`\\\\e');
	});
});

describe("SshIntegration.onToolCall", () => {
	function makeIntegration(): { integration: SshIntegration; cleanup: () => void } {
		const dir = mkdtempSync(join(tmpdir(), "pi-ssh-test-"));
		const ctx: CoreIntegrationContext = {
			cwd: dir,
			sessionManager: SessionManager.inMemory(dir),
					getUI: () => undefined,
				};
		return {
			integration: new SshIntegration(ctx),
			cleanup: () => rmSync(dir, { recursive: true, force: true }),
		};
	}

	it("blocks sshpass in bash", () => {
		const { integration, cleanup } = makeIntegration();
		const decision = integration.onToolCall("bash", { command: "sshpass -p x ssh user@host ls" });
		expect(decision?.block).toBe(true);
		cleanup();
	});

	it("blocks ssh_exec synchronous timeouts above 300s", () => {
		const { integration, cleanup } = makeIntegration();
		const decision = integration.onToolCall("ssh_exec", { host: "box", command: "make", timeout: 600 });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("background:true");
		// background mode and small timeouts pass.
		expect(
			integration.onToolCall("ssh_exec", { host: "box", command: "make", timeout: 600, background: true }),
		).toBeUndefined();
		expect(integration.onToolCall("ssh_exec", { host: "box", command: "make", timeout: 30 })).toBeUndefined();
		cleanup();
	});

	it("does not intercept bg_spawn timeouts (task runtime cap, not synchronous)", () => {
		const { integration, cleanup } = makeIntegration();
		expect(integration.onToolCall("bg_spawn", { task: "make", timeout: 600 })).toBeUndefined();
		expect(integration.onToolCall("bg_spawn", { task: "make", timeout: "2h" })).toBeUndefined();
		cleanup();
	});

	it("does not intercept subagent_spawn timeouts (sub-agent runtime cap)", () => {
		const { integration, cleanup } = makeIntegration();
		expect(integration.onToolCall("subagent_spawn", { task: "scan", timeout: 3600 })).toBeUndefined();
		expect(integration.onToolCall("subagent_spawn", { task: "scan", timeout: "2h" })).toBeUndefined();
		cleanup();
	});

	it("blocks remote ssh in bash", () => {
		const { integration, cleanup } = makeIntegration();
		expect(integration.onToolCall("bash", { command: "ssh user@example.com ls" })?.block).toBe(true);
		expect(integration.onToolCall("bash", { command: "/usr/bin/scp f.txt user@example.com:/tmp/" })?.block).toBe(
			true,
		);
		cleanup();
	});

	it("allows local commands and ssh without a remote user@host", () => {
		const { integration, cleanup } = makeIntegration();
		expect(integration.onToolCall("bash", { command: "ls -la" })).toBeUndefined();
		expect(integration.onToolCall("bash", { command: "ssh -G example.com" })).toBeUndefined();
		expect(integration.onToolCall("bash", { command: "git clone ssh://git@github.com/x/y" })).toBeUndefined();
		cleanup();
	});

	it("allows git-over-SSH to hosting providers but still blocks real servers", () => {
		const { integration, cleanup } = makeIntegration();
		expect(integration.onToolCall("bash", { command: "ssh -T git@github.com" })).toBeUndefined();
		expect(integration.onToolCall("bash", { command: "ssh git@gitlab.com" })).toBeUndefined();
		expect(integration.onToolCall("bash", { command: "ssh root@203.0.113.10 ls" })?.block).toBe(true);
		cleanup();
	});

	it("blocks synchronous timeouts over 300s", () => {
		const { integration, cleanup } = makeIntegration();
		expect(integration.onToolCall("bash", { command: "make", timeout: 600 })?.block).toBe(true);
		expect(integration.onToolCall("ssh_exec", { host: "h", command: "make", timeout: 600 })?.block).toBe(true);
		expect(
			integration.onToolCall("ssh_exec", { host: "h", command: "make", timeout: 600, background: true }),
		).toBeUndefined();
		expect(integration.onToolCall("ssh_exec", { host: "h", command: "make", timeout: "10m" })?.block).toBe(true);
		expect(integration.onToolCall("ssh_exec", { host: "h", command: "make", timeout: "4m" })).toBeUndefined();
		expect(integration.onToolCall("bash", { command: "make", timeout: 60 })).toBeUndefined();
		cleanup();
	});
});

// ── persistent-shell marker protocol ─────────────────────────────────────

class FakeStdin extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	written: string[] = [];
	write(chunk: string): boolean {
		this.written.push(chunk);
		return true;
	}
}

class FakeProc extends EventEmitter {
	stdin = new FakeStdin();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	kill(): void {
		this.killed = true;
	}
}

function fakeConnection(store: SshConnectionStore): { conn: SshConnection; proc: FakeProc } {
	const proc = new FakeProc();
	const conn: SshConnection = {
		key: "u@h:22",
		alias: "h",
		aliases: new Set(["h", "u@h:22"]),
		socket: "/tmp/fake.sock",
		sshTarget: "h",
		proc: proc as unknown as ChildProcess,
		buf: "",
		pending: new Map(),
		reqId: 0,
		startTime: Date.now(),
		lastUse: Date.now(),
	};
	// ensureShell attaches these listeners when it spawns a real process;
	// wire them manually for the fake one.
	proc.stdout.on("data", (chunk: Buffer) => store.appendShellOutput(conn, chunk.toString()));
	proc.stderr.on("data", (chunk: Buffer) => store.appendShellOutput(conn, chunk.toString()));
	return { conn, proc };
}

describe("SshConnectionStore shellExec marker protocol", () => {
	const store = new SshConnectionStore();

	function respond(proc: FakeProc, conn: SshConnection, output: string, exitCode = 0): void {
		const reqId = conn.reqId;
		const pending = conn.pending.get(reqId)!;
		proc.stdout.emit("data", Buffer.from(`${output}__END__${reqId}_${pending.rand}:${exitCode}\n`));
	}

	it("resolves with output before the marker", async () => {
		const { conn, proc } = fakeConnection(store);
		const promise = store.shellExec(conn, "ls", 5_000);
		expect(proc.stdin.written[0]).toContain("ls\necho __END__1_");
		respond(proc, conn, "file1\nfile2\n");
		await expect(promise).resolves.toBe("file1\nfile2\n");
	});

	it("issues increasing request ids", async () => {
		const { conn, proc } = fakeConnection(store);
		const p1 = store.shellExec(conn, "a", 5_000);
		respond(proc, conn, "1\n");
		await p1;
		const p2 = store.shellExec(conn, "b", 5_000);
		respond(proc, conn, "2\n");
		await p2;
		expect(proc.stdin.written[0]).toContain("__END__1_");
		expect(proc.stdin.written[1]).toContain("__END__2_");
	});

	it("strips orphaned marker-like text from output without resolving", async () => {
		const { conn, proc } = fakeConnection(store);
		const promise = store.shellExec(conn, "cat log", 5_000);
		// Output containing a fake marker (wrong rand) followed by the real one
		const pending = conn.pending.get(conn.reqId)!;
		proc.stdout.emit(
			"data",
			Buffer.from(`line with __END__999_fake:0\n inside\nreal output\n__END__${conn.reqId}_${pending.rand}:0\n`),
		);
		const result = await promise;
		expect(result).toContain("real output");
		expect(result).not.toContain("__END__999_fake");
	});

	it("rejects on timeout with partial output", async () => {
		const { conn } = fakeConnection(store);
		await expect(store.shellExec(conn, "sleep 10", 100)).rejects.toThrow(/timeout/i);
	});

	it("rejects pending commands when the shell dies", async () => {
		const { conn, proc } = fakeConnection(store);
		const promise = store.shellExec(conn, "ls", 5_000);
		proc.emit("exit", 1);
		await expect(promise).rejects.toThrow(/exited/i);
	});
});

describe("SshConnectionStore aliases", () => {
	/** Store with disk sync stubbed out — no real socket-dir scanning. */
	class AliasStore extends SshConnectionStore {
		override async syncFromDisk(): Promise<void> {}
		injectConn(conn: SshConnection): void {
			(this as unknown as { connections: Map<string, SshConnection> }).connections.set(conn.key, conn);
			// Register an ssh-config alias the way connect() does on reconnect.
			(this as unknown as { rememberAlias(c: SshConnection, a: string): void }).rememberAlias(conn, "lulab_4090");
		}
	}

	it("findConnection matches a remembered ssh-config alias, not just the key", async () => {
		const store = new AliasStore();
		const { conn } = fakeConnection(store as unknown as SshConnectionStore);
		store.injectConn(conn);

		// The raw key never contains the alias; before the fix this returned
		// undefined while the ControlMaster was alive ("Already connected").
		const found = await store.findConnection("lulab_4090");
		expect(found?.key).toBe(conn.key);
	});

	it("findConnection matches exact alias case-insensitively and by key", async () => {
		const store = new AliasStore();
		const { conn } = fakeConnection(store as unknown as SshConnectionStore);
		store.injectConn(conn);

		expect((await store.findConnection("LULAB_4090"))?.key).toBe(conn.key);
		expect((await store.findConnection("u@h:22"))?.key).toBe(conn.key);
		expect(await store.findConnection("nonexistent")).toBeUndefined();
	});
});
