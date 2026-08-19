import { createHash } from "node:crypto";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";

export interface FileContextEntry {
	hash: string;
	source: "read" | "edit" | "write";
	at: number;
	/** Disk mtime when the model last saw this file (rotation baseline). */
	mtimeMs?: number;
}

/** A file the model has seen that changed on disk since. */
export interface StaleFileNotice {
	/** Absolute path of the file that changed on disk. */
	path: string;
	/** When the change was detected (ms epoch). */
	detectedAt: number;
}

/** One entry of an L1 contact snapshot (recency-ordered). */
export interface FileContactSnapshotEntry {
	path: string;
	source: "read" | "edit" | "write";
	at: number;
}

/** Point-in-time view of the tracker: L1 contacts (most recent first) + L2 stale set. */
export interface FileContextSnapshot {
	files: FileContactSnapshotEntry[];
	stale: string[];
}

/**
 * Formats a file mtime as a locale-aware absolute timestamp, e.g.
 * `2026-08-05 14:32:05 +0800`. Absolute times (rather than relative ages)
 * let the model compare two read results to detect changes itself.
 */
export function formatFileTime(mtimeMs: number): string {
	const d = new Date(mtimeMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	const offsetMinutes = -d.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMinutes);
	const offset = `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset}`;
}

/** Number of touched files kept in the L1 recency list. */
const L1_CAPACITY = 20;
/** Paths stat'ed per rotation batch. */
const ROTATION_BATCH = 200;

/**
 * Keeps the model's view of files fresh, cache-style:
 *
 * - L1 — touched files (contact LRU, hash-precise): files the model read,
 *   edited or wrote. mtime changes here are confirmed against the recorded
 *   content hash before a file is reported stale.
 * - L2 — externally-changed files (notification candidates): fed by rotation
 *   and by touch-time checks.
 * - L3 — project-wide rotation over `git ls-files` paths (mtime-based). Runs
 *   while the agent is idle between turns; batches stop promptly when the
 *   next user input arrives. The baseline mtimes are session-memory only —
 *   the filesystem's own mtime is the source of truth.
 *
 * Consumers: the write tool hard-blocks stale overwrites (`check`), the read
 * and edit tools annotate their results, and the session injects delta
 * notifications for stale files before the model responds.
 */
export class FileContextTracker {
	private files = new Map<string, FileContextEntry>(); // L1
	private lruOrder: string[] = [];
	private stale = new Map<string, number>(); // L2: path -> detectedAt
	private notified = new Set<string>();

	private projectPaths: string[] = []; // L3
	private seenMtime = new Map<string, number>(); // L3 baseline (session memory)
	private rotationIndex = 0;
	private rotationRunning = false;
	private rotationStopRequested = false;
	private rotationPromise: Promise<void> | undefined;

	private hash(content: string): string {
		return createHash("sha256").update(content).digest("hex").substring(0, 16);
	}

	private touchLru(absPath: string): void {
		const idx = this.lruOrder.indexOf(absPath);
		if (idx >= 0) this.lruOrder.splice(idx, 1);
		this.lruOrder.unshift(absPath);
		if (this.lruOrder.length > L1_CAPACITY) {
			const evicted = this.lruOrder.pop()!;
			this.files.delete(evicted);
		}
	}

	/** Record that the model has read a file and its context is current. */
	markRead(absPath: string, content: string, mtimeMs?: number): void {
		this.files.set(absPath, { hash: this.hash(content), source: "read", at: Date.now(), mtimeMs });
		if (mtimeMs !== undefined) this.seenMtime.set(absPath, mtimeMs);
		this.touchLru(absPath);
		this.clearStale(absPath);
	}

	/** Record that the model has edited a file and its context is now current at the new state. */
	markEdited(absPath: string, newContent: string, mtimeMs?: number): void {
		this.files.set(absPath, { hash: this.hash(newContent), source: "edit", at: Date.now(), mtimeMs });
		if (mtimeMs !== undefined) this.seenMtime.set(absPath, mtimeMs);
		this.touchLru(absPath);
		this.clearStale(absPath);
	}

	/** Record that the model has written a file and its context is now current. */
	markWritten(absPath: string, content: string, mtimeMs?: number): void {
		this.files.set(absPath, { hash: this.hash(content), source: "write", at: Date.now(), mtimeMs });
		if (mtimeMs !== undefined) this.seenMtime.set(absPath, mtimeMs);
		this.touchLru(absPath);
		this.clearStale(absPath);
	}

	/**
	 * Check whether the model's context for a file matches disk.
	 * Returns:
	 *  - "current"   : model's hash matches disk → safe to edit
	 *  - "outdated"  : hash mismatch → model must re-read before editing
	 *  - "untracked" : file was never read/written by the model → no opinion
	 */
	check(absPath: string, diskContent: string): "current" | "outdated" | "untracked" {
		const entry = this.files.get(absPath);
		if (!entry) return "untracked";
		const diskHash = this.hash(diskContent);
		return diskHash === entry.hash ? "current" : "outdated";
	}

	/** True when the model's recorded view differs from the given disk content. */
	isOutdated(absPath: string, diskContent: string): boolean {
		return this.check(absPath, diskContent) === "outdated";
	}

	/** Record an externally detected change (rotation or touch-time check). */
	noteExternalChange(absPath: string, detectedAt = Date.now()): void {
		this.stale.set(absPath, detectedAt);
		// A fresh change re-enables notification even for previously notified
		// files (the model only learns about it by being told again).
		this.notified.delete(absPath);
	}

	/** Clear a stale mark (e.g. the model re-read the file). */
	clearStale(absPath: string): void {
		this.stale.delete(absPath);
		this.notified.delete(absPath);
	}

	/** Stale files not yet notified to the model. */
	staleNotices(): StaleFileNotice[] {
		return [...this.stale.entries()]
			.filter(([path]) => !this.notified.has(path))
			.map(([path, detectedAt]) => ({ path, detectedAt }));
	}

	/** Mark files as notified so they are not re-reported until they change again. */
	markNotified(paths: string[]): void {
		for (const path of paths) this.notified.add(path);
	}

	// ── compact-time refresh + snapshot ──────────────────────────────────────

	/**
	 * One-shot L1 check (same logic as rotation Phase 1): stat + hash every
	 * touched file and move externally changed ones into L2. Run right before
	 * a compaction so the checkpoint reflects the freshest file state.
	 */
	async refreshContacts(): Promise<void> {
		await this.checkTouchedFiles();
	}

	/**
	 * Point-in-time view for checkpointing: L1 files in LRU order (most
	 * recently contacted first) and the L2 stale paths.
	 */
	snapshot(): FileContextSnapshot {
		return {
			files: this.lruOrder.map((path) => {
				const entry = this.files.get(path)!;
				return { path, source: entry.source, at: entry.at };
			}),
			stale: [...this.stale.keys()],
		};
	}

	/** Stat + hash every L1 file; external changes land in L2 (rotation Phase 1). */
	private async checkTouchedFiles(): Promise<void> {
		const touched = [...this.files.entries()];
		const stats = await Promise.all(touched.map(([path]) => statSafe(path)));
		for (let i = 0; i < touched.length; i++) {
			const [path, entry] = touched[i]!;
			const st = stats[i];
			if (!st || entry.mtimeMs === undefined || st.mtimeMs === entry.mtimeMs) continue;
			entry.mtimeMs = st.mtimeMs;
			const content = await readFileSafe(path);
			if (content !== undefined && this.hash(content) !== entry.hash) {
				this.noteExternalChange(path);
			}
		}
	}

	// ── L3 rotation ──────────────────────────────────────────────────────────

	/** Provide the project path set (e.g. `git ls-files`, resolved to absolute). */
	noteProjectPaths(paths: string[]): void {
		this.projectPaths = paths;
	}

	get rotationActive(): boolean {
		return this.rotationRunning;
	}

	/** Start rotating while the agent is idle. No-op when already running. */
	startRotation(): void {
		if (this.rotationRunning || this.rotationPromise) return;
		this.rotationRunning = true;
		this.rotationStopRequested = false;
		this.rotationPromise = this.rotateLoop();
	}

	/** Stop rotation. Batches check the flag between stat groups. */
	stopRotation(): void {
		this.rotationStopRequested = true;
	}

	private async rotateLoop(): Promise<void> {
		try {
			while (!this.rotationStopRequested) {
				// Phase 1: touched files first — the model's active files get
				// priority. mtime changes are confirmed against the recorded
				// content hash before reporting stale (guards against mtime
				// churn from in-flight writers).
				await this.checkTouchedFiles();
				if (this.rotationStopRequested) break;

				// Phase 2: one batch from the project rotation cursor.
				if (this.projectPaths.length > 0) {
					const batch: string[] = [];
					const startIndex = this.rotationIndex;
					for (let i = 0; i < ROTATION_BATCH && this.projectPaths.length > 0; i++) {
						batch.push(this.projectPaths[this.rotationIndex % this.projectPaths.length]!);
						this.rotationIndex = (this.rotationIndex + 1) % this.projectPaths.length;
					}
					const wrapped = this.rotationIndex <= startIndex; // one full sweep done
					const batchStats = await Promise.all(batch.map((path) => statSafe(path)));
					for (let i = 0; i < batch.length; i++) {
						const st = batchStats[i];
						if (!st) continue;
						// L1 files are tracked authoritatively by Phase 1 (hash-precise)
						// — including the model's own writes, which must never be
						// reported as external changes.
						if (this.files.has(batch[i]!)) continue;
						const prev = this.seenMtime.get(batch[i]!);
						// mtime-only check (no content hash here): a file already
						// marked stale needs no re-notification on every mtime bump
						// (in-flight writers churn mtimes; one stale note suffices).
						if (prev !== undefined && st.mtimeMs !== prev && !this.stale.has(batch[i]!)) {
							this.noteExternalChange(batch[i]!);
						}
						this.seenMtime.set(batch[i]!, st.mtimeMs);
					}
					// The sweep completed — stop until the next idle window, so a new
					// rotation starts a fresh baseline instead of hot-looping.
					if (wrapped) break;
				}
				// Yield so the loop never busy-spins; the stop flag is re-checked
				// at the top of the next iteration.
				await new Promise((resolve) => setImmediate(resolve));
			}
		} finally {
			this.rotationRunning = false;
			this.rotationPromise = undefined;
		}
	}
}

async function statSafe(path: string): Promise<{ mtimeMs: number } | undefined> {
	try {
		return await fsStat(path);
	} catch {
		return undefined; // deleted or unreadable — not stale, just gone
	}
}

async function readFileSafe(path: string): Promise<string | undefined> {
	try {
		return await fsReadFile(path, "utf-8");
	} catch {
		return undefined;
	}
}
