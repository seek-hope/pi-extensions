/**
 * Tests for the post-edit scan: identifier extraction from edit diffs and
 * the CLI-driven read-only reference scan (best-effort, deadline-capped).
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractChangedIdentifiers, runPostEditScan } from "../src/core/tools/post-edit-scan.ts";

describe("extractChangedIdentifiers", () => {
	it("finds identifiers removed by the edit", () => {
		const changed = extractChangedIdentifiers([
			{ oldText: "const oldName = 1;\nfoo(oldName);", newText: "const newName = 1;\nfoo(newName);" },
		]);
		expect(changed).toContain("oldName");
		expect(changed).not.toContain("newName"); // kept in newText
		expect(changed).not.toContain("const"); // stopword
		expect(changed).not.toContain("foo"); // unchanged
	});

	it("caps the number of identifiers and skips short ones", () => {
		const changed = extractChangedIdentifiers([
			{
				oldText: "a b cc ddd eeee fffff gggggg hhhhhhh",
				newText: "x",
			},
		]);
		expect(changed.every((id) => id.length >= 3)).toBe(true);
		expect(changed.length).toBeLessThanOrEqual(3);
	});

	it("returns nothing when no identifiers were removed", () => {
		expect(extractChangedIdentifiers([{ oldText: "foo(bar)", newText: "foo(bar, baz)" }])).toEqual([]);
		expect(extractChangedIdentifiers([])).toEqual([]);
	});
});

describe("runPostEditScan", () => {
	let binDir: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		originalPath = process.env.PATH;
		binDir = mkdtempSync(join(tmpdir(), "codegraph-fake-"));
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		rmSync(binDir, { recursive: true, force: true });
	});

	/** Put a fake `codegraph` script on PATH running the given shell body. */
	function fakeCodegraph(body: string): void {
		const bin = join(binDir, "codegraph");
		writeFileSync(bin, `#!/bin/sh\n${body}\n`);
		chmodSync(bin, 0o755);
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
	}

	it("lists callers for changed identifiers via the CLI", async () => {
		fakeCodegraph(`echo "Callers of \\"$2\\" (2):"; echo "src/a.ts:42"; echo "src/b.ts:7"`);
		const scan = await runPostEditScan(["oldName"], { cwd: binDir });
		expect(scan).toContain("oldName");
		expect(scan).toContain("src/a.ts:42");
		expect(scan).toContain("src/b.ts:7");
	});

	it("returns undefined when the binary is missing", async () => {
		process.env.PATH = binDir; // empty dir — no codegraph on PATH
		const scan = await runPostEditScan(["oldName"], { cwd: binDir });
		expect(scan).toBeUndefined();
	});

	it("returns undefined when the CLI fails", async () => {
		fakeCodegraph(`echo "boom" >&2; exit 1`);
		const scan = await runPostEditScan(["oldName"], { cwd: binDir });
		expect(scan).toBeUndefined();
	});

	it("treats the CLI not-found marker as no result", async () => {
		fakeCodegraph(`echo "i Symbol \\"$2\\" not found"`);
		const scan = await runPostEditScan(["oldName"], { cwd: binDir });
		expect(scan).toBeUndefined();
	});

	it("respects the deadline and kills a slow child", async () => {
		fakeCodegraph(`sleep 10`);
		const start = Date.now();
		const scan = await runPostEditScan(["oldName"], { cwd: binDir, deadlineMs: 100 });
		expect(scan).toBeUndefined();
		expect(Date.now() - start).toBeLessThan(5000);
	});
});
