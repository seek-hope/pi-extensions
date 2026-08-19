/**
 * BackgroundTaskStore — process-global tmux-based background task execution.
 *
 * Ported from the bg-tasks extension. The store is a process-wide singleton:
 * tasks live in tmux sessions and on disk, so every AgentSession in the
 * process sees the same task list. UI bindings (widget, notifications,
 * follow-up messages) are per-session via subscribe().
 *
 * Tasks survive pi session shutdown. Output goes to log files on disk.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_LOG_READ = 1024 * 1024; // 1MB max read per task log
const MAX_POLL_ERRORS = 5;

export interface BackgroundTask {
	id: string;
	/** Full command text — used for execution and /fg display only, never shown in lists. */
	description: string;
	/** Human-readable summary shown in task lists and notifications (caller-provided). */
	label?: string;
	cwd: string;
	status: "running" | "done" | "error" | "killed";
	startTime: number;
	endTime?: number;
	exitCode?: number;
	logFile: string;
	/** Run timeout in ms (internal — tool params are seconds). */
	timeoutMs?: number;
	/** True once this task's terminal notification+follow-up has been delivered,
	 * so finalizeAndSettle and pollCompletion can't both notify for the same
	 * completion (script and poll races over the ~2s window). */
	finalized?: boolean;
	/** Session that spawned this task. Only that session receives the
	 * completion notification (mirrors the SSH remote-task isolation).
	 * Undefined for tasks restored from disk by older versions — those
	 * broadcast to all sessions (legacy behavior). */
	sessionId?: string;
	/** Additional sessions that adopted this task via spawn-dedup; when set,
	 * completion notifies every listed session (supersedes sessionId). */
	sessionIds?: string[];
}

export interface BackgroundTaskEvents {
	/** Task list changed (spawn/status/widget refresh). Optional. */
	onChange?(): void;
	/** Task reached a terminal state. output may be truncated. */
	onTaskFinished(task: BackgroundTask, output: string): void;
	/** Informational message (resumed polling, recovered task, errors). */
	onNotify(message: string, level: "info" | "warning" | "error"): void;
}

function defaultTaskDir(): string {
	return join(getAgentDir(), "tasks");
}

function loadTasksFrom(file: string): Map<string, BackgroundTask> {
	const m = new Map<string, BackgroundTask>();
	try {
		if (existsSync(file)) {
			const parsed = JSON.parse(readFileSync(file, "utf-8"));
			if (Array.isArray(parsed)) {
				for (const t of parsed) {
					// Migrate pre-timeoutMs files: the field used to be `timeout`.
					if (t.timeoutMs === undefined && typeof t.timeout === "number") {
						t.timeoutMs = t.timeout;
						delete t.timeout;
					}
					m.set(t.id, t);
				}
			}
		}
	} catch (err) {
		console.warn(
			`bg-tasks: failed to load ${file} — ${(err as Error)?.message || String(err)}. Tasks will be recovered from log files on next poll.`,
		);
		try {
			const bak = `${file}.corrupt.${Date.now()}`;
			writeFileSync(bak, readFileSync(file));
			console.warn(`bg-tasks: backed up corrupted tasks.json to ${bak}`);
		} catch {
			/* backup also failed — proceed without */
		}
	}
	return m;
}

/** Check whether a tmux session with the given id still exists.
 *  Returns `true` if alive, `false` if definitively dead, or `"error"` if the check itself failed. */
async function tmuxHasSession(id: string): Promise<boolean | "error"> {
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("tmux", ["has-session", "-t", id], { stdio: ["ignore", "pipe", "pipe"] });
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error("timed out"));
			}, 5_000);
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`tmux has-session exited with code ${code}`));
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		return true;
	} catch (e: any) {
		if (e.message === "timed out" || e.code === "ENOENT" || e.code === "EACCES") {
			return "error";
		}
		return false;
	}
}

async function tmuxKillSession(id: string): Promise<void> {
	return new Promise<void>((resolve) => {
		const child = spawn("tmux", ["kill-session", "-t", id], { stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			child.kill();
			resolve();
		}, 5_000);
		child.on("close", () => {
			clearTimeout(timer);
			resolve();
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** Read a task log file with a size cap to prevent OOM on multi-GB output */
async function readTaskLog(filePath: string): Promise<string> {
	const stats = await stat(filePath);
	if (stats.size <= MAX_LOG_READ) {
		return await readFile(filePath, "utf-8");
	}
	// Read last MAX_LOG_READ bytes (where EXIT_CODE marker and recent output lives)
	const fd = await open(filePath, "r");
	const buf = Buffer.alloc(MAX_LOG_READ);
	try {
		await fd.read(buf, 0, MAX_LOG_READ, stats.size - MAX_LOG_READ);
	} finally {
		await fd.close();
	}
	// Skip UTF-8 continuation bytes at the start of the buffer
	let start = 0;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
	return buf.toString("utf-8", start, buf.length);
}

export class BackgroundTaskStore {
	readonly dir: string;
	private readonly tasks: Map<string, BackgroundTask>;
	private spawnCounter = 0;
	private readonly pollingTasks = new Set<string>();
	private readonly spawningLocks = new Map<string, { ts: number; taskId?: string }>();
	private readonly spawningScripts = new Set<string>();
	private readonly taskTimers = new Map<string, NodeJS.Timeout>();
	private readonly listeners = new Map<string, BackgroundTaskEvents>();

	constructor(dir?: string) {
		this.dir = dir ?? defaultTaskDir();
		this.tasks = loadTasksFrom(join(this.dir, "tasks.json"));
	}

	subscribe(events: BackgroundTaskEvents, id?: string): () => void {
		const listenerId = id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		this.listeners.set(listenerId, events);
		return () => {
			this.listeners.delete(listenerId);
		};
	}

	private emitChange(): void {
		for (const [, l] of this.listeners) {
			try {
				l.onChange?.();
			} catch {
				/* listener errors must not break the store */
			}
		}
	}

	private emitFinished(task: BackgroundTask, output: string): void {
		for (const [id, l] of this.listeners) {
			// Session isolation: a task's completion goes to the session(s)
			// that spawned or adopted it. Tasks without any session (restored
			// from disk by older versions) broadcast, matching SSH semantics.
			const targets = task.sessionIds ?? (task.sessionId ? [task.sessionId] : undefined);
			if (targets && !targets.includes(id)) continue;
			try {
				l.onTaskFinished(task, output);
			} catch {
				/* ignore */
			}
		}
	}

	private emitNotify(message: string, level: "info" | "warning" | "error" = "info", task?: BackgroundTask): void {
		// Task-scoped notifications follow the same session isolation as
		// emitFinished: without it, one session's task events leak into every
		// other session's UI. Store-level messages (no task) still broadcast.
		const targets = task ? (task.sessionIds ?? (task.sessionId ? [task.sessionId] : undefined)) : undefined;
		for (const [id, l] of this.listeners) {
			if (targets && !targets.includes(id)) continue;
			try {
				l.onNotify(message, level);
			} catch {
				/* ignore */
			}
		}
	}

	private saveTasks(): void {
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, "tasks.json"), JSON.stringify([...this.tasks.values()], null, 2));
	}

	list(): BackgroundTask[] {
		return [...this.tasks.values()];
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	runningCount(): number {
		let n = 0;
		for (const t of this.tasks.values()) if (t.status === "running") n++;
		return n;
	}

	/**
	 * Dedup hit: adopt the existing running task for this caller — refresh
	 * its label when the caller provided one, and register the caller's
	 * session for the completion notification (otherwise the adopting
	 * session would never be woken when the task finishes).
	 */
	private adoptExisting(task: BackgroundTask, sessionId?: string, label?: string): BackgroundTask {
		let changed = false;
		if (label && task.label !== label) {
			task.label = label;
			changed = true;
		}
		if (sessionId && task.sessionId !== sessionId && !(task.sessionIds ?? []).includes(sessionId)) {
			task.sessionIds = [
				...new Set([task.sessionId, ...(task.sessionIds ?? []), sessionId].filter(Boolean)),
			] as string[];
			changed = true;
		}
		if (changed) this.saveTasks();
		return task;
	}

	// ── spawn ────────────────────────────────────────────────────────────

	async spawn(
		description: string,
		cwd: string,
		timeoutMs: number,
		sessionId?: string,
		label?: string,
	): Promise<BackgroundTask> {
		const lockKey = createHash("sha256").update(description).update("\0").update(cwd).digest("hex").slice(0, 16);
		// Deduplicate: identical task (same description, cwd) already running → return existing.
		for (const [, t] of this.tasks) {
			if (t.status === "running" && t.description === description && t.cwd === cwd) {
				const alive = await tmuxHasSession(t.id);
				if (alive === true) return this.adoptExisting(t, sessionId, label);
				if (alive === "error") continue;
				t.status = "error";
				t.exitCode = -1;
				t.endTime = Date.now();
				this.saveTasks();
			}
		}
		// TOCTOU guard: atomically check-and-acquire the lock.
		let deadline = Date.now() + 10_000;
		const maxWait = Date.now() + 60_000;
		let id = "";
		let adoptedId = "";
		for (;;) {
			if (!this.spawningLocks.has(lockKey)) {
				if (adoptedId) {
					id = adoptedId;
					adoptedId = "";
				} else {
					// Random suffix: a process restart within the same millisecond
					// resets the counter, which could otherwise collide with a
					// stale task id and overwrite its script/log files.
					id = `task-${Date.now().toString(36)}-${String(this.spawnCounter++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 6)}`;
				}
				this.spawningLocks.set(lockKey, { ts: Date.now(), taskId: id });
				const taskAfterLock = [...this.tasks.values()].find(
					(t) => t.status === "running" && t.description === description && t.cwd === cwd,
				);
				if (taskAfterLock) {
					this.spawningLocks.delete(lockKey);
					return this.adoptExisting(taskAfterLock, sessionId, label);
				}
				const lockData = this.spawningLocks.get(lockKey);
				if (lockData?.taskId) {
					const sessionAlive = await tmuxHasSession(lockData.taskId);
					if (sessionAlive === true) {
						const existingTask = this.tasks.get(lockData.taskId);
						if (existingTask) {
							this.spawningLocks.delete(lockKey);
							return this.adoptExisting(existingTask, sessionId, label);
						}
					}
				}
				const ourLockData = this.spawningLocks.get(lockKey);
				if (!ourLockData?.taskId) {
					this.spawningLocks.delete(lockKey);
					continue;
				}
				id = ourLockData.taskId;
				break;
			}
			const existing = [...this.tasks.values()].find(
				(t) => t.status === "running" && t.description === description && t.cwd === cwd,
			);
			if (existing) return this.adoptExisting(existing, sessionId, label);
			const holderData = this.spawningLocks.get(lockKey);
			if (holderData?.taskId && this.tasks.has(holderData.taskId)) {
				const t = this.tasks.get(holderData.taskId)!;
				if (t.status === "running") return this.adoptExisting(t, sessionId, label);
			}
			if (Date.now() > maxWait) {
				const lockData = this.spawningLocks.get(lockKey);
				if (lockData?.taskId) {
					const alive = await tmuxHasSession(lockData.taskId);
					if (alive === true) adoptedId = lockData.taskId;
				}
				this.spawningLocks.delete(lockKey);
				continue;
			}
			if (Date.now() > deadline) {
				const existingAfterDeadline = [...this.tasks.values()].find(
					(t) => t.status === "running" && t.description === description && t.cwd === cwd,
				);
				if (existingAfterDeadline) return this.adoptExisting(existingAfterDeadline, sessionId, label);
				const lockData = this.spawningLocks.get(lockKey);
				if (lockData && Date.now() - lockData.ts > 10_000) {
					if (lockData.taskId) {
						const alive = await tmuxHasSession(lockData.taskId);
						if (alive === true) {
							deadline = Date.now() + 5_000;
							await new Promise((resolve) => setTimeout(resolve, 100));
							continue;
						}
					}
					this.spawningLocks.delete(lockKey);
					await new Promise((resolve) => setTimeout(resolve, 100));
					continue;
				}
				deadline = Date.now() + 10_000;
				await new Promise((resolve) => setTimeout(resolve, 100));
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const logFile = join(this.dir, `${id}.log`);
		mkdirSync(this.dir, { recursive: true });
		const startTime = Date.now();

		// Write the command to a standalone script file — avoids shell escaping issues.
		const taskScript = join(this.dir, `${id}.sh`);
		const wrapperScript = [
			`cd '${(cwd ?? process.cwd()).replace(/'/g, "'\\''")}'`,
			`bash '${taskScript.replace(/'/g, "'\\''")}' > '${logFile.replace(/'/g, "'\\''")}' 2>&1`,
			`echo "EXIT_CODE=$?" >> '${logFile.replace(/'/g, "'\\''")}'`,
		].join("\n");
		writeFileSync(taskScript, description);
		const wrapperFile = join(this.dir, `${id}_wrapper.sh`);
		writeFileSync(wrapperFile, wrapperScript);
		this.spawningScripts.add(id);

		const task: BackgroundTask = {
			id,
			description,
			label,
			cwd,
			status: "running",
			startTime,
			logFile,
			timeoutMs,
			sessionId,
		};
		this.tasks.set(id, task);

		try {
			try {
				await new Promise<void>((resolve, reject) => {
					const child = spawn(
						"tmux",
						[
							"new-session",
							"-d",
							"-s",
							id,
							`bash '${wrapperFile.replace(/'/g, "'\\''")}' ; rm -f '${wrapperFile.replace(/'/g, "'\\''")}' '${taskScript.replace(/'/g, "'\\''")}'`,
						],
						{ stdio: ["ignore", "pipe", "pipe"] },
					);
					const timer = setTimeout(() => {
						child.kill();
						reject(new Error("tmux new-session timed out"));
					}, 10_000);
					child.on("close", (code) => {
						clearTimeout(timer);
						if (code === 0) resolve();
						else reject(new Error(`tmux new-session exited with code ${code}`));
					});
					child.on("error", (err) => {
						clearTimeout(timer);
						reject(err);
					});
				});
			} catch {
				this.tasks.delete(id);
				this.spawningScripts.delete(id);
				try {
					unlinkSync(taskScript);
				} catch {
					/* ok */
				}
				try {
					unlinkSync(wrapperFile);
				} catch {
					/* ok */
				}
				throw new Error(`Failed to start tmux session for task ${id}`);
			}

			this.saveTasks();
			this.spawningScripts.delete(id);
			this.pollCompletion(id);
			if (timeoutMs > 0) this.armTimeout(id, timeoutMs);
			this.emitChange();
			// Make the spawn visible in the UI. Completion already notifies
			// (finalizeAndSettle); without this the TUI shows nothing when a
			// task starts and the user may assume bg_spawn did not run.
			this.emitNotify(`▶ Background task ${task.id} started${task.label ? ` — ${task.label}` : ""}`, "info", task);
			return task;
		} finally {
			this.spawningLocks.delete(lockKey);
		}
	}

	// ── status finalization ─────────────────────────────────────────────

	/**
	 * Read a task's log and finalize its status if EXIT_CODE was found.
	 * Mutates task.status/exitCode/endTime when completion is detected.
	 */
	async finalizeTaskOutput(task: BackgroundTask): Promise<string> {
		if (!existsSync(task.logFile)) return "(no output yet)";
		try {
			const content = await readTaskLog(task.logFile);
			// LAST EXIT_CODE= wins (command output may contain spurious matches).
			let exitMatch: RegExpExecArray | null = null;
			const re = /EXIT_CODE=(\d+)/g;
			for (let match = re.exec(content); match !== null; match = re.exec(content)) {
				exitMatch = match;
			}
			if (exitMatch && task.status === "running") {
				// Verify the tmux session is actually dead before trusting EXIT_CODE.
				const sessionAlive = await tmuxHasSession(task.id);
				if (sessionAlive === true) return content;
				task.exitCode = parseInt(exitMatch[1], 10);
				task.status = task.exitCode === 0 ? "done" : "error";
				task.endTime = Date.now();
				// Caller persists.
			}
			return content;
		} catch {
			return "(cannot read)";
		}
	}

	/**
	 * Atomically claim the single notification for a finished task. Returns
	 * true only for the first caller; everyone after (concurrent poll tick,
	 * a second finalizeAndSettle) returns false and must NOT notify again.
	 */
	private claimFinalized(task: BackgroundTask): boolean {
		if (task.finalized) return false;
		task.finalized = true;
		return true;
	}

	/**
	 * Finalize a task and, when it reached a terminal state outside the
	 * completion poller (e.g. via bg_output/fg probing in the ~2s poll
	 * window), settle it fully: persist, notify, deliver the completion
	 * follow-up, and prune. Without this the poller would see a non-running
	 * task on its next tick and quietly clean up WITHOUT emitting the
	 * completion notification — the wake-up would be lost.
	 */
	async finalizeAndSettle(task: BackgroundTask): Promise<string> {
		const output = await this.finalizeTaskOutput(task);
		if (task.status === "running") return output;
		// Atomic guard: emit the terminal notification+follow-up exactly once,
		// even if the completion poller is concurrently finalizing the same
		// task (it checks the same flag and skips its own emission).
		if (!this.claimFinalized(task)) return output;
		this.pollingTasks.delete(task.id);
		clearTimeout(this.taskTimers.get(task.id));
		this.taskTimers.delete(task.id);
		const icon = task.status === "done" ? "✓" : "✗";
		this.emitNotify(
			`${icon} Background task ${task.id} completed (${task.status})`,
			task.status === "done" ? "info" : "error",
			task,
		);
		if (task.status !== "killed") {
			this.emitFinished(task, output);
		}
		this.pruneFinishedTask(task.id);
		return output;
	}

	// ── kill ─────────────────────────────────────────────────────────────

	async kill(id: string): Promise<boolean> {
		// Validate id to prevent path traversal
		if (!/^task-[a-z0-9-]+$/.test(id)) return false;
		const task = this.tasks.get(id);
		if (!task) {
			// Task not in map — might be in the spawn window. Kill the tmux session directly.
			const sessionExists = await tmuxHasSession(id);
			if (sessionExists === true) {
				await tmuxKillSession(id);
				try {
					unlinkSync(join(this.dir, `${id}.sh`));
				} catch {
					/* ok */
				}
				try {
					unlinkSync(join(this.dir, `${id}_wrapper.sh`));
				} catch {
					/* ok */
				}
				return true;
			}
			return false;
		}
		await tmuxKillSession(id);
		const stillAlive = await tmuxHasSession(id);
		if (stillAlive === true) return false;

		task.status = "killed";
		task.endTime = Date.now();
		this.pollingTasks.delete(id);
		clearTimeout(this.taskTimers.get(id));
		this.taskTimers.delete(id);
		this.pruneFinishedTask(id);
		return true;
	}

	// ── timeout ──────────────────────────────────────────────────────────

	private armTimeout(id: string, timeoutMs: number): void {
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const t = this.tasks.get(id);
					if (t && t.status === "running") {
						try {
							await this.finalizeTaskOutput(t);
						} catch {
							/* finalize failed — fall through to kill */
						}
						if (t.status !== "running") {
							// finalizeTaskOutput settled it (tmux already dead): deliver the
							// completion exactly once (notify + follow-up + prune) instead
							// of silently persisting it.
							await this.finalizeAndSettle(t);
							return;
						}
						await tmuxKillSession(id);
						const stillAlive = await tmuxHasSession(id);
						if (stillAlive === true) {
							this.pollingTasks.delete(id);
							this.taskTimers.delete(id);
							this.saveTasks();
							this.emitChange();
							return;
						}
						t.status = "killed";
						t.endTime = Date.now();
						this.pollingTasks.delete(id);
						this.taskTimers.delete(id);
						// A timeout kill must not go unnoticed — the model may be
						// waiting on this task's result.
						this.emitNotify(`✗ Background task ${id} killed: exceeded its timeout`, "error", t);
						this.emitFinished(t, `(killed: exceeded timeout — no output collected)`);
						this.pruneFinishedTask(id);
					} else {
						this.taskTimers.delete(id);
					}
				} catch {
					const t = this.tasks.get(id);
					if (t && t.status === "running") {
						await tmuxKillSession(id);
						const stillAlive = await tmuxHasSession(id);
						if (stillAlive !== true) {
							t.status = "killed";
							t.endTime = Date.now();
							this.emitNotify(`✗ Background task ${id} killed: exceeded its timeout`, "error", t);
							this.emitFinished(t, `(killed: exceeded timeout — no output collected)`);
						}
						this.pollingTasks.delete(id);
						this.taskTimers.delete(id);
						this.pruneFinishedTask(id);
					}
				}
			})();
		}, timeoutMs);
		this.taskTimers.set(id, timer);
	}

	// ── completion polling ────────────────────────────────────────────────

	private pollCompletion(id: string): void {
		if (this.pollingTasks.has(id)) return;
		this.pollingTasks.add(id);

		// Re-arm timeout for recovered tasks that lost their timer on restart.
		const task = this.tasks.get(id);
		if (task?.timeoutMs && task.timeoutMs > 0 && !this.taskTimers.has(id)) {
			const elapsed = Date.now() - task.startTime;
			const remainingTimeout = Math.max(task.timeoutMs - elapsed, 60_000);
			this.armTimeout(id, remainingTimeout);
		}

		let consecutiveErrors = 0;
		const check = async () => {
			try {
				const current = this.tasks.get(id);
				if (!current || current.status !== "running") {
					this.pollingTasks.delete(id);
					clearTimeout(this.taskTimers.get(id));
					this.taskTimers.delete(id);
					return;
				}
				const sessionExists = await tmuxHasSession(id);
				if (sessionExists === true) {
					consecutiveErrors = 0;
					this.emitChange();
					setTimeout(() => void check(), 2000);
					return;
				}
				if (sessionExists === "error") {
					consecutiveErrors++;
					if (consecutiveErrors >= MAX_POLL_ERRORS) {
						current.status = "error";
						current.exitCode = -1;
						current.endTime = Date.now();
						this.pollingTasks.delete(id);
						clearTimeout(this.taskTimers.get(id));
						this.taskTimers.delete(id);
						this.emitNotify(
							`✗ Background task ${id} failed: tmux unavailable or too many errors (${consecutiveErrors})`,
							"error",
							current,
						);
						this.pruneFinishedTask(id);
						return;
					}
					this.emitChange();
					setTimeout(() => void check(), 2000);
					return;
				}

				// Session ended — finalize status from the log.
				const latest = this.tasks.get(id);
				if (!latest || latest.status !== "running") {
					this.pollingTasks.delete(id);
					clearTimeout(this.taskTimers.get(id));
					this.taskTimers.delete(id);
					return;
				}
				await this.finalizeTaskOutput(latest);
				if (latest.status === "running") {
					latest.status = "error";
					latest.exitCode = -1;
					latest.endTime = Date.now();
				}

				this.pollingTasks.delete(id);
				clearTimeout(this.taskTimers.get(id));
				this.taskTimers.delete(id);
				let output = "";
				try {
					output = await readTaskLog(latest.logFile);
				} catch {
					/* file may have been removed */
				}
				const finalStatus = latest.status as BackgroundTask["status"];
				// If finalizeAndSettle (or another poll tick racing the ~2s window)
				// already delivered the terminal notification, don't emit again.
				if (!this.claimFinalized(latest)) {
					this.pruneFinishedTask(id);
					return;
				}
				const icon = finalStatus === "done" ? "✓" : "✗";
				this.emitNotify(
					`${icon} Background task ${id} completed (${finalStatus})`,
					finalStatus === "done" ? "info" : "error",
					latest,
				);
				if (finalStatus !== "killed") {
					this.emitFinished(latest, output);
				}
				// Finished immediately: the notification above carries the output.
				this.pruneFinishedTask(id);
			} catch (err) {
				const t = this.tasks.get(id);
				if (t && t.status === "running") {
					t.status = "error";
					t.exitCode = -1;
					t.endTime = Date.now();
					this.pollingTasks.delete(id);
					clearTimeout(this.taskTimers.get(id));
					this.taskTimers.delete(id);
					this.emitNotify(
						`✗ Background task ${id} failed with unexpected error: ${err instanceof Error ? err.message : err}`,
						"error",
						t,
					);
					this.pruneFinishedTask(id);
				}
			}
		};
		setTimeout(() => void check(), 2000);
	}

	// ── startup sync: resume polling, recover orphans, GC ────────────────

	async sync(): Promise<void> {
		// Finished records loaded from disk (their completion notifications were
		// delivered long ago) are pruned silently on the first sync.
		let pruned = false;
		for (const [id, task] of [...this.tasks]) {
			if (task.status !== "running") {
				this.deleteTaskFiles(id);
				this.tasks.delete(id);
				pruned = true;
			}
		}
		if (pruned) {
			this.saveTasks();
			this.emitChange();
		}

		for (const [, task] of this.tasks) {
			if (task.status !== "running") continue;
			if (this.spawningScripts.has(task.id)) continue;
			const sessionExists = await tmuxHasSession(task.id);
			if (sessionExists === true) {
				this.emitNotify(`◐ Resumed polling for background task ${task.id}`, "info", task);
				this.pollCompletion(task.id);
			} else if (sessionExists === "error") {
				// Can't confirm — leave for next sync cycle.
			} else {
				try {
					await this.finalizeTaskOutput(task);
				} catch {
					/* log file may be gone */
				}
				if (task.status === "running") {
					task.status = "error";
					task.exitCode = -1;
					task.endTime = Date.now();
				}
				const status = task.status as BackgroundTask["status"];
				if (status !== "running") {
					let output = "";
					try {
						output = await readTaskLog(task.logFile);
					} catch {
						/* file may be gone */
					}
					this.emitFinished(task, output);
					this.pruneFinishedTask(task.id);
				} else {
					this.saveTasks();
				}
			}
		}

		// Recover orphaned tasks from .log files (survives corrupted tasks.json).
		// MUST run before GC of .sh files.
		try {
			const files = readdirSync(this.dir);
			const logFiles = files.filter(
				(f) => f.endsWith(".log") && !this.tasks.has(f.slice(0, -".log".length)) && f.startsWith("task-"),
			);
			for (const logFile of logFiles) {
				const taskId = logFile.slice(0, -".log".length);
				const logFilePath = join(this.dir, logFile);
				if (!existsSync(join(this.dir, `${taskId}.sh`))) continue;

				const sessionExists = await tmuxHasSession(taskId);
				let content = "";
				try {
					content = await readTaskLog(logFilePath);
				} catch {
					/* can't read */
				}
				let exitMatch: RegExpExecArray | null = null;
				const exitRe = /EXIT_CODE=(\d+)/g;
				for (let match = exitRe.exec(content); match !== null; match = exitRe.exec(content)) {
					exitMatch = match;
				}

				let description = "(recovered)";
				let recoveredCwd = process.cwd();
				try {
					const scriptPath = join(this.dir, `${taskId}.sh`);
					if (existsSync(scriptPath)) {
						description = readFileSync(scriptPath, "utf-8").trim().substring(0, 200);
					}
					// The wrapper (still present while the task runs) records the
					// original working directory in its cd line.
					const wrapperPath = join(this.dir, `${taskId}_wrapper.sh`);
					if (existsSync(wrapperPath)) {
						const wrapper = readFileSync(wrapperPath, "utf-8");
						const cdMatch = /^cd '((?:[^'\\]|'\\'')*)'$/m.exec(wrapper);
						if (cdMatch) recoveredCwd = cdMatch[1]!.replace(/'\\''/g, "'");
					}
				} catch {
					/* ignore */
				}

				const idParts = taskId.split("-");
				const startTime = idParts.length > 1 ? parseInt(idParts[1], 36) || Date.now() : Date.now();
				// Default runtime cap for recovered tasks without a recorded timeout:
				// 12h, matching the bg_spawn default.
				const maxRuntime = 12 * 3600 * 1000;
				const elapsed = Date.now() - startTime;
				const remainingTimeout = Math.max(maxRuntime - elapsed, 60_000);

				const task: BackgroundTask = {
					id: taskId,
					description,
					cwd: recoveredCwd,
					status:
						sessionExists === true
							? "running"
							: exitMatch
								? parseInt(exitMatch[1], 10) === 0
									? "done"
									: "error"
								: "error",
					startTime,
					logFile: logFilePath,
					timeoutMs: sessionExists === true ? remainingTimeout : undefined,
				};
				if (exitMatch) {
					task.exitCode = parseInt(exitMatch[1], 10);
					task.endTime = Date.now();
				}
				this.tasks.set(taskId, task);

				if (sessionExists === true) {
					this.emitNotify(`◐ Recovered and resumed polling for background task ${taskId}`, "info", task);
					this.pollCompletion(taskId);
				} else {
					let output = "";
					try {
						output = await readTaskLog(task.logFile);
					} catch {
						/* file may be removed */
					}
					this.emitFinished(task, output);
					this.pruneFinishedTask(taskId);
				}
			}
		} catch {
			/* task dir may not exist */
		}

		// GC orphaned .sh/_wrapper.sh files not associated with any known task.
		try {
			const files = readdirSync(this.dir);
			for (const file of files) {
				let taskId: string | null = null;
				if (file.endsWith("_wrapper.sh")) {
					taskId = file.slice(0, -"_wrapper.sh".length);
				} else if (file.endsWith(".sh")) {
					taskId = file.slice(0, -".sh".length);
				} else {
					continue;
				}
				if (!this.tasks.has(taskId) && !this.spawningScripts.has(taskId)) {
					const sessionExists = await tmuxHasSession(taskId);
					if (sessionExists === true) continue;
					try {
						unlinkSync(join(this.dir, file));
					} catch {
						/* ok */
					}
				}
			}
		} catch {
			/* task dir may not exist yet */
		}

		this.emitChange();
	}

	/**
	 * Immediately prune a finished task: record + log + scripts. The completion
	 * notification has already been delivered by the caller (it carries the
	 * output), so finished tasks never linger in the list.
	 */
	private pruneFinishedTask(id: string): void {
		const t = this.tasks.get(id);
		if (!t || t.status === "running") return;
		this.deleteTaskFiles(id);
		this.tasks.delete(id);
		this.saveTasks();
		this.emitChange();
	}

	/** Remove a finished task's log and script files (best-effort). */
	private deleteTaskFiles(id: string): void {
		for (const suffix of [".log", ".sh", "_wrapper.sh"]) {
			try {
				unlinkSync(join(this.dir, `${id}${suffix}`));
			} catch {
				/* ok */
			}
		}
	}
}

// ── process-wide singleton ────────────────────────────────────────────────

let instance: BackgroundTaskStore | undefined;

export function getBackgroundTaskStore(): BackgroundTaskStore {
	if (!instance) {
		instance = new BackgroundTaskStore();
	}
	return instance;
}
