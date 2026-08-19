import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileContextTracker, formatFileTime } from "../shared/file-context.ts";

describe("formatFileTime", () => {
	it("formats an absolute timestamp with the local UTC offset", () => {
		// 2026-08-05 06:32:05 UTC = 14:32:05 +0800
		const formatted = formatFileTime(Date.UTC(2026, 7, 5, 6, 32, 5));
		expect(formatted).toMatch(/^2026-08-05 \d{2}:32:05 [+-]\d{4}$/);
	});

	it("round-trips through the Date constructor", () => {
		const now = Date.now();
		const parsed = new Date(formatFileTime(now));
		expect(Math.floor(parsed.getTime() / 1000)).toBe(Math.floor(now / 1000));
	});
});

describe("FileContextTracker L1 (touched files)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-file-context-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("evicts least-recently-touched files beyond the L1 capacity", () => {
		const tracker = new FileContextTracker();
		for (let i = 0; i < 25; i++) {
			const path = join(dir, `f${i}.txt`);
			writeFileSync(path, `content ${i}`);
			tracker.markRead(path, `content ${i}`, 1_000 + i);
		}
		// 25 touches > 20 capacity: the first 5 are evicted.
		expect(tracker.check(join(dir, "f0.txt"), "content 0")).toBe("untracked");
		expect(tracker.check(join(dir, "f24.txt"), "content 24")).toBe("current");
		// Touching a brand-new file beyond capacity evicts the least-recent one.
		tracker.markRead(join(dir, "f25.txt"), "content 25", 1_000);
		expect(tracker.check(join(dir, "f5.txt"), "content 5")).toBe("untracked");
		expect(tracker.check(join(dir, "f25.txt"), "content 25")).toBe("current");
	});

	it("stale notices are cleared by a fresh read and re-raise after another change", async () => {
		const tracker = new FileContextTracker();
		const path = join(dir, "a.txt");
		writeFileSync(path, "v1");
		tracker.markRead(path, "v1", (await statOf(path)).mtimeMs);

		tracker.noteExternalChange(path);
		expect(tracker.staleNotices()).toEqual([{ path, detectedAt: expect.any(Number) }]);

		// Notified files are not re-reported until they change again.
		tracker.markNotified([path]);
		expect(tracker.staleNotices()).toEqual([]);

		// A fresh read clears the stale mark and the notified flag.
		tracker.markRead(path, "v2", (await statOf(path)).mtimeMs);
		expect(tracker.staleNotices()).toEqual([]);
		expect(tracker.check(path, "v2")).toBe("current");
	});

	it("snapshot returns L1 contacts in LRU order plus L2 stale paths", async () => {
		const tracker = new FileContextTracker();
		const a = join(dir, "a.txt");
		const b = join(dir, "b.txt");
		writeFileSync(a, "a");
		writeFileSync(b, "b");
		tracker.markRead(a, "a", (await statOf(a)).mtimeMs);
		tracker.markEdited(b, "b", (await statOf(b)).mtimeMs);

		// Touch `a` again so the LRU order is [a, b].
		tracker.markRead(a, "a", (await statOf(a)).mtimeMs);
		tracker.noteExternalChange(a);

		const snapshot = tracker.snapshot();
		expect(snapshot.files.map((f) => f.path)).toEqual([a, b]);
		expect(snapshot.files[0]).toMatchObject({ source: "read" });
		expect(snapshot.files[1]).toMatchObject({ source: "edit" });
		expect(snapshot.stale).toEqual([a]);
	});

	it("refreshContacts detects external changes on L1 files (one-shot check)", async () => {
		const tracker = new FileContextTracker();
		const path = join(dir, "t.txt");
		writeFileSync(path, "original");
		tracker.markRead(path, "original", (await statOf(path)).mtimeMs);

		// External edit after the contact was recorded.
		writeFileSync(path, "modified");

		expect(tracker.staleNotices()).toEqual([]);
		await tracker.refreshContacts();
		expect(tracker.staleNotices()[0]?.path).toBe(path);

		// The one-shot refresh reports a changed file only once; re-running
		// without further changes stays silent.
		tracker.markNotified([path]);
		await tracker.refreshContacts();
		expect(tracker.staleNotices()).toEqual([]);
	});
});

describe("FileContextTracker rotation (idle L1/L3 checks)", () => {
	let dir: string;
	let tracker: FileContextTracker;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-file-rotation-"));
		tracker = new FileContextTracker();
	});

	afterEach(async () => {
		tracker.stopRotation();
		// Let the loop observe the stop flag and settle.
		await new Promise((resolve) => setTimeout(resolve, 50));
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects an external change on a touched file (mtime + hash confirm)", async () => {
		const path = join(dir, "touched.txt");
		writeFileSync(path, "original");
		tracker.markRead(path, "original", (await statOf(path)).mtimeMs);

		// External edit.
		writeFileSync(path, "modified");

		tracker.startRotation();
		await waitFor(() => tracker.staleNotices().length > 0, 2_000);
		expect(tracker.staleNotices()[0]?.path).toBe(path);
	});

	it("rotation covers project paths from the L3 set", async () => {
		const a = join(dir, "a.txt");
		const b = join(dir, "b.txt");
		writeFileSync(a, "a1");
		writeFileSync(b, "b1");
		tracker.noteProjectPaths([a, b]);
		// Prime the rotation baseline.
		tracker.startRotation();
		await waitFor(() => !tracker.rotationActive, 2_000); // one full sweep
		expect(tracker.staleNotices()).toEqual([]);

		writeFileSync(b, "b2");
		tracker.startRotation();
		await waitFor(() => tracker.staleNotices().length > 0, 2_000);
		expect(tracker.staleNotices()[0]?.path).toBe(b);
	});

	it("stopRotation terminates the loop promptly", async () => {
		tracker.noteProjectPaths([join(dir, "x.txt")]);
		writeFileSync(join(dir, "x.txt"), "x");
		tracker.startRotation();
		await waitFor(() => tracker.rotationActive, 1_000);
		tracker.stopRotation();
		await waitFor(() => !tracker.rotationActive, 1_000);
	});
});

async function statOf(path: string): Promise<{ mtimeMs: number }> {
	const { stat } = await import("node:fs/promises");
	return stat(path);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
