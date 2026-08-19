/**
 * Tests for SSH sudo support: in-memory password store, priming command
 * construction, and primed-state lifecycle. No live SSH host needed —
 * shellExec is stubbed to capture the injected command.
 */
import { describe, expect, it } from "vitest";
import { type SshConnection, SshConnectionStore } from "../ssh/lib/store.ts";

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

/** Store subclass with shellExec stubbed — captures commands instead of executing. */
class TestStore extends SshConnectionStore {
	captured: string[] = [];
	override async shellExec(_conn: SshConnection, cmd: string, _timeout: number): Promise<string> {
		this.captured.push(cmd);
		return "";
	}
	/** Test hook: register a connection without opening SSH. */
	injectConn(conn: SshConnection): void {
		(this as unknown as { connections: Map<string, SshConnection> }).connections.set(conn.key, conn);
	}
}

describe("SSH sudo support", () => {
	it("stores passwords in memory only and reports presence", () => {
		const store = new TestStore();
		expect(store.hasSudoPassword("host-a")).toBe(false);
		store.setSudoPassword("host-a", "secret");
		expect(store.hasSudoPassword("host-a")).toBe(true);
	});

	it("priming writes the password to a 0600 file behind an askpass helper, then marks primed", async () => {
		const store = new TestStore();
		const conn = makeConn("host-a");
		store.injectConn(conn);
		store.setSudoPassword("host-a", "secret");

		await store.primeSudo(conn);
		expect(store.captured).toHaveLength(1);
		// Password goes into a file (via the prime command text), not the env.
		expect(store.captured[0]).toContain("printf '%s' 'secret' >");
		expect(store.captured[0]).toContain("sudo()");
		expect(store.captured[0]).toContain("sudo -A");
		expect(store.captured[0]).toContain("SUDO_ASKPASS");
		// Exported so nohup bash -c children inherit the helper.
		expect(store.captured[0]).toContain("export -f sudo");
		expect(store.captured[0]).toContain("export __PI_SUDOPW_DIR");
		// The password must never be exported into the environment (it would be
		// readable via `env` / /proc/*/environ and leak into model-visible output).
		expect(store.captured[0]).not.toContain("export __PI_SUDOPW=");
		expect(store.captured[0]).not.toContain("__PI_SUDOPW='");
		expect(conn.sudoPrimed).toBe(true);

		// Second call without force: no re-injection.
		await store.primeSudo(conn);
		expect(store.captured).toHaveLength(1);
	});

	it("escapes single quotes in passwords", async () => {
		const store = new TestStore();
		const conn = makeConn("host-a");
		store.injectConn(conn);
		store.setSudoPassword("host-a", "it's");

		await store.primeSudo(conn);
		expect(store.captured[0]).toContain("printf '%s' 'it'\\''s' >");
	});

	it("re-primes when the password changes", async () => {
		const store = new TestStore();
		const conn = makeConn("host-a");
		store.injectConn(conn);
		store.setSudoPassword("host-a", "first");
		await store.primeSudo(conn);
		expect(conn.sudoPrimed).toBe(true);

		store.setSudoPassword("host-a", "second");
		expect(conn.sudoPrimed).toBe(false); // stale copy invalidated
		await store.primeSudo(conn);
		expect(store.captured[1]).toContain("printf '%s' 'second' >");
	});

	it("invalidates the prime for session-scoped keys (production format)", async () => {
		const store = new TestStore();
		const conn = makeConn("user@host:22");
		store.injectConn(conn);
		const key = `ssh-abc123:${conn.key}`;
		store.setSudoPassword(key, "first");
		await store.primeSudo(conn, false, key);
		expect(conn.sudoPrimed).toBe(true);

		// A new password under the same session-scoped key must invalidate the
		// cached prime (the lookup strips the "<sessionId>:" prefix).
		store.setSudoPassword(key, "second");
		expect(conn.sudoPrimed).toBe(false);
		await store.primeSudo(conn, false, key);
		expect(store.captured[1]).toContain("printf '%s' 'second' >");
	});

	it("primeSudo without a stored password throws", async () => {
		const store = new TestStore();
		const conn = makeConn("host-a");
		await expect(store.primeSudo(conn)).rejects.toThrow(/No sudo password/);
	});
});
