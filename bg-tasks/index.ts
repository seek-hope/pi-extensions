/**
 * bg-tasks (pi-ex): tmux background tasks, migrated from pi-ex core's
 * BackgroundTasksIntegration.
 *
 * Tools: bg_spawn / bg_status / bg_output / bg_kill. Commands: /tasks /fg
 * /kill. Completion notifications batch into one follow-up message.
 * Also registers the bg spawner on the fork host bridge so core bash's
 * sleep→bg conversion keeps working.
 *
 * State lives in the process-wide store (~/.pi/agent/tasks/) — it survives
 * session restarts and is shared with the wait extension's wake message.
 */
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { setBgSpawner } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type BackgroundTask, type BackgroundTaskStore, getBackgroundTaskStore } from "./lib/store.ts";

export const MAX_BG_SLEEP_SECONDS = 12 * 3600;

/**
 * Find sleep invocations exceeding {@link MAX_BG_SLEEP_SECONDS} in a task
 * command. Handles `sleep N`, `sleep Ns`, `sleep Nm`, `sleep Nh`, and
 * fractional values.
 */
export function findOversizedSleep(command: string): { value: number; unit: string; seconds: number } | undefined {
	const re = /(?:^|[;\n&|]|\bdo\s+|\bthen\s+|\belse\s+)\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
	let match = re.exec(command);
	while (match) {
		const value = Number.parseFloat(match[1]);
		const unit = match[2] || "s";
		const factor = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
		const seconds = value * factor;
		if (seconds > MAX_BG_SLEEP_SECONDS) {
			return { value, unit: unit || "s", seconds };
		}
		match = re.exec(command);
	}
	return undefined;
}

const TIMEOUT_SCHEMA = Type.Optional(
	Type.Union([Type.Integer({ minimum: 1 }), Type.String()], {
		description: "Timeout in seconds, or with a unit suffix ('30s', '500ms', '5m', '2h')",
	}),
);

function timeoutToMs(input: number | string): number {
	if (typeof input === "number") return input * 1000;
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(input.trim());
	if (!m) throw new Error(`Invalid timeout "${input}" — use seconds or a suffix like '30s', '5m', '2h'.`);
	const value = Number(m[1]);
	const unit = m[2]!;
	const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	return Math.round(value * factor);
}

/** Per-session notification subscription. */
const subscribed = new WeakSet<SessionManager>();

function ensureSubscription(ctx: ExtensionContext, store: BackgroundTaskStore): void {
	const sm = ctx.sessionManager as unknown as SessionManager;
	if (subscribed.has(sm)) return;
	subscribed.add(sm);
	const sessionId = sm.getSessionId();
	let pendingResults: Array<{ task: BackgroundTask; output: string }> = [];
	let batchTimer: ReturnType<typeof setTimeout> | null = null;
	store.subscribe(
		{
			onNotify: (message, level) => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			},
			onTaskFinished: (task, output) => {
				pendingResults.push({ task, output });
				if (batchTimer) clearTimeout(batchTimer);
				batchTimer = setTimeout(() => {
					batchTimer = null;
					const results = pendingResults.splice(0);
					if (results.length === 0) return;
					const parts: string[] = [];
					if (results.length > 1) parts.push(`${results.length} background tasks completed:`);
					for (const { task: t, output: o } of results) {
						const label = t.label ? ` — ${t.label}` : "";
						parts.push(`[${t.id} completed (${t.status})]${label}`);
						const cap = results.length === 1 ? 4000 : 800;
						const truncated = o.length > cap;
						parts.push(
							`Output:\n${o.substring(0, cap)}${truncated ? `\n... (truncated${results.length === 1 ? ` — full output: ${t.logFile}` : ", log already pruned"})` : ""}`,
						);
					}
					parts.push(
						"",
						"Check the outputs and keep going — continue with the next step of the work; only report back to the user once everything is done.",
					);
					ctx.sendUserMessage(parts.join("\n"), { triggerTurn: true, deliverAs: "followUp" });
				}, 1000);
			},
		},
		sessionId,
	);
}

async function taskOutput(
	store: BackgroundTaskStore,
	id: string,
): Promise<{ task: BackgroundTask; output: string } | undefined> {
	const task = store.get(id);
	if (!task) return undefined;
	const output = await store.finalizeAndSettle(task);
	if (!existsSync(task.logFile) && task.status !== "running") {
		return { task, output: "(output was delivered with the completion notification; the task has been pruned)" };
	}
	return { task, output };
}

export default function (pi: ExtensionAPI) {
	const store = getBackgroundTaskStore();

	// Core bash.ts's sleep→bg conversion reads this via the fork host bridge.
	setBgSpawner((task, cwd, timeoutMs, sessionId, label) => store.spawn(task, cwd, timeoutMs, sessionId, label));

	pi.on("session_start", (_event, ctx) => {
		ensureSubscription(ctx, store);
		void store.sync();
	});

	pi.registerTool({
		name: "bg_spawn",
		label: "Background Task",
		description:
			"Start a background task in a tmux session. Returns a task ID and log file path. " +
			"The task continues running even if the session ends. " +
			"Use bg_status to check progress, read the logFile to see output.",
		promptSnippet: "Start a task in background via tmux — survives session end.",
		promptGuidelines: [
			"Use bg_spawn for long-running local tasks (builds, servers, downloads, training).",
			"bg_spawn returns a logFile path — use the read tool to check output anytime.",
			"For remote long-running tasks, use ssh_exec with nohup on the server side.",
			"Tasks survive pi session shutdown. They keep running in tmux.",
			"Use /tasks (TUI) to manage tasks, /fg <id> to view output, /kill <id> to stop.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Command or task to run in background" }),
			label: Type.Optional(
				Type.String({
					description:
						"Human-readable summary shown in task lists and notifications (e.g. 'npm run build'). The command text itself is never displayed.",
				}),
			),
			timeout: TIMEOUT_SCHEMA,
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureSubscription(ctx, store);
			let timeoutMs: number | undefined;
			if (params.timeout != null) {
				try {
					timeoutMs = timeoutToMs(params.timeout);
				} catch (err) {
					return {
						content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
						details: {},
						isError: true,
					};
				}
			}
			const badSleep = findOversizedSleep(params.task);
			if (badSleep) {
				return {
					content: [
						{
							type: "text",
							text: `sleep ${badSleep.value}${badSleep.unit} (${Math.round(badSleep.seconds)}s) exceeds the 12-hour cap for background tasks. Split the wait into shorter sleeps or schedule it differently.`,
						},
					],
					details: {},
					isError: true,
				};
			}
			const task = await store.spawn(
				params.task,
				ctx.cwd,
				timeoutMs ?? 12 * 3600 * 1000,
				ctx.sessionManager.getSessionId(),
				params.label,
			);
			return {
				content: [
					{
						type: "text",
						text: [
							"Background task started.",
							`ID: ${task.id}`,
							`Log: ${task.logFile}`,
							"",
							`Check: /fg ${task.id}  |  Kill: /kill ${task.id}  |  Manage: /tasks`,
						].join("\n"),
					},
				],
				details: { taskId: task.id, logFile: task.logFile },
			};
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Status",
		description: "Check the status of all background tasks.",
		parameters: Type.Object({}),
		async execute() {
			await store.sync();
			const tasks = store.list();
			if (tasks.length === 0) {
				return { content: [{ type: "text", text: "No background tasks." }], details: {} };
			}
			const lines = ["Background tasks:"];
			for (const t of tasks) {
				const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
				const icon = t.status === "done" ? "✓" : t.status === "running" ? "◐" : "✗";
				const label = t.label ? `: ${t.label}` : "";
				lines.push(`  ${icon} ${t.id}${label} (${elapsed.toFixed(0)}s)`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "bg_output",
		label: "Background Task Output",
		description:
			"Read the output of a background task (tail of its log file). " +
			"Use after bg_status shows a task finished or when you want to check progress without reading the raw log path.",
		parameters: Type.Object({
			task_id: Type.String({ description: "Task ID (from bg_spawn/bg_status)." }),
			tail_lines: Type.Optional(
				Type.Integer({
					description: "How many lines from the end of the log to return (default 50, max 500).",
					minimum: 1,
					maximum: 500,
				}),
			),
		}),
		async execute(_toolCallId, { task_id, tail_lines }) {
			const task = store.get(task_id);
			if (!task) {
				return {
					content: [{ type: "text", text: `Task ${task_id} not found.` }],
					details: {},
					isError: true,
				};
			}
			const output = await store.finalizeAndSettle(task);
			const lines = output.split("\n");
			const tail = tail_lines ?? 50;
			const shown = lines.slice(-tail);
			const status = `[${task.id} ${task.status}${task.exitCode != null ? ` exit=${task.exitCode}` : ""}]`;
			const truncated = lines.length > shown.length;
			const text = [
				status,
				...shown,
				truncated ? `... (${lines.length - shown.length} earlier lines omitted; tail_lines up to 500)` : "",
			].join("\n");
			return { content: [{ type: "text", text }], details: { taskId: task.id, status: task.status } };
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Background Task Kill",
		description:
			"Stop a background task (kills its tmux session and marks it killed). " +
			"Use to stop runaway or no-longer-needed tasks.",
		parameters: Type.Object({
			task_id: Type.String({ description: "Task ID to stop (from bg_spawn/bg_status)." }),
		}),
		async execute(_toolCallId, { task_id }) {
			const task = store.get(task_id);
			if (!task) {
				return {
					content: [{ type: "text", text: `Task ${task_id} not found.` }],
					details: {},
					isError: true,
				};
			}
			const killed = await store.kill(task_id);
			return {
				content: [
					{
						type: "text",
						text: killed ? `Task ${task_id} killed.` : `Task ${task_id} could not be killed.`,
					},
				],
				details: { taskId: task_id, killed },
			};
		},
	});

	pi.registerCommand("tasks", {
		description: "List background tasks",
		handler: async (_args, ctx) => {
			ensureSubscription(ctx, store);
			await store.sync();
			const tasks = store.list();
			if (!ctx.hasUI) return;
			if (tasks.length === 0) {
				ctx.ui.notify("No background tasks.", "info");
				return;
			}
			const lines = ["Background tasks:"];
			for (const t of tasks) {
				const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
				const icon = t.status === "done" ? "✓" : t.status === "running" ? "◐" : "✗";
				const label = t.label ? `: ${t.label}` : "";
				lines.push(`  ${icon} ${t.id}${label} (${elapsed.toFixed(0)}s)`);
			}
			lines.push("", "· /fg <id> output · /kill <id> stop · /attach <id> terminal");
			ctx.ui.setWidget("bg-tasks", lines);
		},
	});

	pi.registerCommand("fg", {
		description: "Show a background task's current output (/fg <id>)",
		handler: async (args, ctx) => {
			ensureSubscription(ctx, store);
			const id = args.trim();
			if (!id) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /fg <task-id>", "warning");
				return;
			}
			const result = await taskOutput(store, id);
			if (!result) {
				if (ctx.hasUI) ctx.ui.notify(`Task ${id} not found.`, "warning");
				return;
			}
			if (!ctx.hasUI) return;
			const outputLines = result.output.split("\n");
			const tail = outputLines.slice(-30);
			ctx.ui.setWidget("bg-task-output", [
				`[${result.task.id} ${result.task.status}${result.task.exitCode != null ? ` exit=${result.task.exitCode}` : ""}]`,
				...tail,
				...(outputLines.length > tail.length ? [`… ${outputLines.length - tail.length} earlier lines — full log: ${result.task.logFile}`] : []),
			]);
		},
	});

	pi.registerCommand("kill", {
		description: "Stop a background task (/kill <id>)",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /kill <task-id>", "warning");
				return;
			}
			const killed = await store.kill(id);
			if (ctx.hasUI) ctx.ui.notify(killed ? `Task ${id} killed.` : `Task ${id} could not be killed.`, killed ? "info" : "warning");
		},
	});
}
