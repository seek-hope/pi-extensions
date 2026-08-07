/**
 * Agent Browser extension for pi — wraps the agent-browser CLI (Vercel Labs).
 * Official upstream: https://github.com/vercel-labs/agent-browser
 *
 * Requires the CLI: npm install -g agent-browser && agent-browser install
 * Each tool call runs one `agent-browser batch --json` invocation
 * (open → action → close), mirroring the old playwright extension's
 * open-act-close semantics. Commands go via stdin JSON — no shell escaping.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_OUTPUT_CHARS = 50_000;

function validateUrl(url: string): void {
	if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
		throw new Error(`Invalid URL: ${url} — only http/https URLs are supported`);
	}
}

interface BatchEntry {
	command: string[];
	success: boolean;
	result?: Record<string, unknown>;
	error?: string | null;
}

/** Run a command sequence in one browser session; returns per-command entries. */
function runBatch(commands: string[][]): Promise<BatchEntry[]> {
	return new Promise((resolve, reject) => {
		const child = spawn("agent-browser", ["batch", "--json"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("agent-browser timed out after 120s"));
		}, 120_000);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(
				new Error(
					`agent-browser not available: ${err.message}. Install: npm install -g agent-browser && agent-browser install`,
				),
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			try {
				const parsed = JSON.parse(stdout) as BatchEntry[];
				resolve(parsed);
			} catch {
				reject(new Error(`agent-browser exited ${code}: ${stderr || stdout}`.slice(0, 2000)));
			}
		});
		child.stdin.write(JSON.stringify(commands));
		child.stdin.end();
	});
}

/**
 * Open the URL and wait until the navigation actually landed. The CLI's
 * `open` occasionally reports success while the page stays about:blank
 * (a daemon race), so poll `get url` and re-issue `open` when it never
 * navigates.
 */
async function openAndSettle(url: string): Promise<void> {
	const origin = new URL(url).origin;
	for (let attempt = 0; attempt < 3; attempt++) {
		mustOk(await runBatch([["open", url]]));
		for (let i = 0; i < 10; i++) {
			const entries = await runBatch([["get", "url"]]);
			const current = entries[0]?.result?.url;
			if (typeof current === "string" && current.startsWith(origin)) return;
			await new Promise((r) => setTimeout(r, 300));
		}
		// Never navigated — re-issue open.
	}
	// Gave up — proceed anyway; the action may still succeed.
}

/** Assert every step succeeded; return the entries otherwise. */
function mustOk(entries: BatchEntry[]): BatchEntry[] {
	for (const e of entries) {
		if (e.command[0] === "close") continue; // best-effort
		if (!e.success) {
			throw new Error(`${e.command.join(" ")} failed: ${e.error ?? "unknown error"}`);
		}
	}
	return entries;
}

function truncate(s: string): string {
	return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated)` : s;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "agent_browser_snapshot",
		label: "Agent Browser Snapshot",
		description:
			"Open a URL and capture a text snapshot of the page (accessibility tree with @e refs). Powered by agent-browser.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to load and snapshot", minLength: 1 }),
		}),
		async execute(_id, params) {
			validateUrl(params.url);
			await openAndSettle(params.url);
			const entries = mustOk(await runBatch([["snapshot"], ["close"]]));
			const snap = entries.find((e) => e.command[0] === "snapshot")?.result?.snapshot;
			return {
				content: [{ type: "text", text: truncate(typeof snap === "string" ? snap : JSON.stringify(snap)) }],
				details: {},
			};
		},
		renderResult: (result) => new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0),
	});

	pi.registerTool({
		name: "agent_browser_eval",
		label: "Agent Browser Eval",
		description: "Navigate to URL and evaluate JavaScript in the page. Powered by agent-browser.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to load", minLength: 1 }),
			script: Type.String({ description: "JavaScript expression to evaluate", minLength: 1 }),
		}),
		async execute(_id, params) {
			validateUrl(params.url);
			await openAndSettle(params.url);
			const entries = mustOk(await runBatch([["eval", params.script], ["close"]]));
			const evalEntry = entries.find((e) => e.command[0] === "eval");
			const value = evalEntry?.result?.result;
			const text = truncate(typeof value === "string" ? value : JSON.stringify(value, null, 2));
			return { content: [{ type: "text", text }], details: {} };
		},
		renderResult: (result) => new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0),
	});

	pi.registerTool({
		name: "agent_browser_click",
		label: "Agent Browser Click",
		description:
			'Navigate to URL and click an element described by text/selector (e.g. "Sign in button", css selector ".login", or a snapshot ref like @e2). Powered by agent-browser.',
		parameters: Type.Object({
			url: Type.String({ description: "URL to load", minLength: 1 }),
			target: Type.String({ description: "Element description or selector", minLength: 1 }),
			snapshotAfter: Type.Optional(Type.Boolean({ description: "Return page snapshot after click (default: true)" })),
		}),
		async execute(_id, params) {
			validateUrl(params.url);
			await openAndSettle(params.url);
			const commands: string[][] = [["click", params.target]];
			if (params.snapshotAfter !== false) commands.push(["snapshot"]);
			commands.push(["close"]);
			const entries = mustOk(await runBatch(commands));
			if (params.snapshotAfter === false) {
				return { content: [{ type: "text", text: `Clicked ${params.target}` }], details: {} };
			}
			const snap = entries.find((e) => e.command[0] === "snapshot")?.result?.snapshot;
			return {
				content: [{ type: "text", text: truncate(typeof snap === "string" ? snap : JSON.stringify(snap)) }],
				details: {},
			};
		},
		renderResult: (result) => new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0),
	});

	pi.registerTool({
		name: "agent_browser_fill",
		label: "Agent Browser Fill",
		description: "Navigate to URL and fill a form field. Powered by agent-browser.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to load", minLength: 1 }),
			target: Type.String({ description: "Field description or selector", minLength: 1 }),
			text: Type.String({ description: "Text to fill" }),
		}),
		async execute(_id, params) {
			validateUrl(params.url);
			await openAndSettle(params.url);
			mustOk(await runBatch([["fill", params.target, params.text], ["close"]]));
			return { content: [{ type: "text", text: `Filled ${params.target}` }], details: {} };
		},
		renderResult: (result) => new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0),
	});
}
