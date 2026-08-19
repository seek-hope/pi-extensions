/**
 * fork-ask-wait (pi-ex): the ask_user and wait tools, migrated from pi-ex core.
 *
 * - ask_user: dialog prompts to the user via the extension UI (headless
 *   sessions get the flagged-assumption fallback).
 * - wait: suspend the turn and resume automatically after N seconds. The
 *   wake-up is delivered as steer (mid-turn) or followUp (idle); the bg-task
 *   listing in the wake message is read from the shared bg-tasks store file
 *   (~/.pi/agent/tasks/tasks.json) on a best-effort basis.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

// ── ask_user ────────────────────────────────────────────────────────────────

export const askUserParameters = Type.Object({
	questions: Type.Array(Type.String(), {
		description:
			"The questions to ask. Pass ALL questions in one call — they are asked consecutively and the answers return together.",
		minItems: 1,
		maxItems: 8,
	}),
});

export const ASK_USER_DESCRIPTION =
	"Call this tool to ask the user questions whenever you are not at least 98% confident that you understand their true intent — do not guess as a substitute. " +
	"You can ask multiple questions in one call: pass them all in the questions array; they are asked consecutively and the answers return together. " +
	"Not available in headless sessions; calling it there fails with a message telling you to proceed with a flagged assumption.";

export async function executeAskUser(
	{ questions }: Static<typeof askUserParameters>,
	ctx: ExtensionContext,
): Promise<AgentToolResult<undefined>> {
	const answered: string[] = [];
	let interrupted = false;
	for (const question of questions) {
		if (!ctx.hasUI) {
			interrupted = true;
			break;
		}
		const answer = await ctx.ui.input(question);
		if (answer === undefined || answer.trim() === "") {
			interrupted = true;
			// User dismissed one dialog: keep asking the rest (they may still
			// answer), but note the gap in the result.
			answered.push("");
		} else {
			answered.push(answer);
		}
	}
	if (interrupted && answered.length === 0) {
		return {
			content: [
				{
					type: "text",
					text:
						"ask_user is unavailable (no UI in this environment). " +
						"Proceed with your best-effort assumption and flag it inline on its own line, e.g.\n" +
						"[uncertain:inference] <the assumption you are proceeding with>",
				},
			],
			details: undefined,
		};
	}
	const asked = questions.slice(0, answered.length);
	const lines = asked.map((q, i) => {
		const answer = answered[i];
		return `Q: ${q}\nA: ${answer === "" ? "(no answer — user dismissed the dialog)" : answer}`;
	});
	return {
		content: [{ type: "text", text: `User answers:\n\n${lines.join("\n\n")}` }],
		details: undefined,
	};
}

// ── wait ────────────────────────────────────────────────────────────────────

export const waitParameters = Type.Object({
	timeout: Type.Integer({
		description:
			"How long to wait before resuming, in seconds. Set a reasonable value covering the expected remaining duration of the running tasks. " +
			"Interactive sessions: up to 43200 (12 hours). Headless sessions: up to 120.",
		minimum: 1,
	}),
});

export const WAIT_DESCRIPTION =
	"Call this tool when tasks are still running and you plan to stop producing output until they complete. " +
	"Set a reasonable timeout that covers the expected remaining duration of those tasks. " +
	"This should be the last tool call of the turn; the turn ends and resumes automatically when the wait completes. " +
	"Background-task and sub-agent completions wake the agent earlier automatically. " +
	"Prefer it over busy-waiting, polling loops, or long bash sleeps. " +
	"Interactive sessions: up to 12 hours. Headless sessions: up to 120 seconds, 5 uses per session.";

const WAIT_WAKEUP_MESSAGE = "The wait you requested has ended — resume your work where you left off.\n";

export interface WaitState {
	timer: NodeJS.Timeout | undefined;
	headlessCount: number;
	ctx: ExtensionContext | undefined;
}

const waitStates = new WeakMap<SessionManager, WaitState>();

export function stateFor(sm: SessionManager): WaitState {
	let s = waitStates.get(sm);
	if (!s) {
		s = { timer: undefined, headlessCount: 0, ctx: undefined };
		waitStates.set(sm, s);
	}
	return s;
}

export function cancelWait(s: WaitState): void {
	if (s.timer) {
		clearTimeout(s.timer);
		s.timer = undefined;
	}
}

interface BgTaskRecord {
	id: string;
	status: string;
	startTime: number;
	label?: string;
}

function listRunningBgTasks(): { text: string; stillRunning: boolean } {
	try {
		const file = join(homedir(), ".pi", "agent", "tasks", "tasks.json");
		if (!existsSync(file)) return { text: "  (no background tasks running)", stillRunning: false };
		const tasks = JSON.parse(readFileSync(file, "utf-8")) as BgTaskRecord[];
		const running = tasks.filter((t) => t.status === "running");
		if (running.length === 0) return { text: "  (no background tasks running)", stillRunning: false };
		const text = running
			.map((t) => {
				const elapsed = ((Date.now() - t.startTime) / 1000).toFixed(0);
				const label = t.label ? `: ${t.label}` : "";
				return `  ◐ ${t.id}${label} (${elapsed}s)`;
			})
			.join("\n");
		return { text, stillRunning: true };
	} catch {
		return { text: "  (background task list unavailable)", stillRunning: false };
	}
}

export function scheduleWait(seconds: number, clamp: boolean, ctx: ExtensionContext): { ok: boolean; message?: string; error?: string } {
	const hasUI = ctx.hasUI;
	const max = hasUI ? 12 * 3600 : 120;
	if (seconds < 1 || (seconds > max && !clamp)) {
		return { ok: false, error: `wait duration ${seconds}s is out of range (interactive: 1–${12 * 3600}s; headless: 1–120s).` };
	}
	let clamped = false;
	if (seconds > max) {
		seconds = max;
		clamped = true;
	}
	const state = stateFor(ctx.sessionManager);
	if (!hasUI) {
		if (state.headlessCount >= 5) {
			return { ok: false, error: "Headless wait limit reached: 5 waits per session. Continue without waiting." };
		}
		state.headlessCount++;
	}
	cancelWait(state);
	state.ctx = ctx;
	state.timer = setTimeout(() => {
		state.timer = undefined;
		const { text: tasks, stillRunning } = listRunningBgTasks();
		const guidance = stillRunning
			? "Tasks still running — you can wait again to rest until they finish."
			: "Check their outputs and continue; start new background tasks as needed.";
		const deliverAs = ctx.isIdle() ? "followUp" : "steer";
		ctx.sendUserMessage(`${WAIT_WAKEUP_MESSAGE}\nCurrent background tasks:\n${tasks}\n\n${guidance}`, {
			triggerTurn: true,
			deliverAs,
		});
	}, seconds * 1000);
	const clampNote = clamped ? ` (capped at ${max}s — the wait limit for this session)` : "";
	return {
		ok: true,
		message: `Waiting ${seconds}s${clampNote}. The current turn ends now and resumes automatically when the wait completes — background-task completions wake the agent earlier.`,
	};
}

