/**
 * SubagentRunner — drives one in-process sub-agent run via the Agent runtime.
 *
 * Write path (default): harness base tools scoped to a dedicated git
 * worktree (bash/read/edit/write). Read-only path: bash (write-gated) and
 * read only, running in the shared project directory — the report is the
 * entire deliverable. Both share the ModelRuntime (no re-auth) and — when
 * depth allows — get a scoped subagent toolset for recursive delegation.
 */
import {
	Agent,
	type AgentHarnessTool,
	type AgentTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { contentText, type Usage } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SubAgentUsage } from "./types.ts";

export interface SubagentRunOptions {
	id: string;
	task: string;
	/** Read-only path: write-gated bash + read only, in the shared project dir. */
	readOnly?: boolean;
	/** Working directory — the sub-agent's filesystem root (worktree or project root). */
	cwd: string;
	/** Branch name ("" for readOnly agents). */
	branch: string;
	projectRoot: string;
	modelRuntime: ModelRuntime;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	depth: number;
	maxDepth: number;
	/** Recursive toolset factory; not consulted when depth+1 >= maxDepth. */
	childTools?: (depth: number, spawnerId: string) => AgentHarnessTool<ExecutionToolContext>[];
	/**
	 * Additional developer instructions appended to the sub-agent prompt
	 * (codex multi-agent v2: subagent_developer_instructions).
	 */
	subagentInstructions?: string;
	/** Called right after the Agent is constructed (steering registration). */
	onAgentCreated?: (agent: Agent) => void;
	onProgress?: (text: string) => void;
	signal?: AbortSignal;
}

export interface SubagentRunResult {
	result: string;
	usage: SubAgentUsage;
	stopReason: string;
	errorMessage?: string;
}

const PATH_LINES = {
	readOnly:
		"PATH: read-only — you mechanically cannot modify anything: no edit/write tools, and bash rejects write-like commands. Your written report is the entire deliverable (no commit/review happens).",
	write: "PATH: write — you have full tools (read, edit, write, bash) inside a dedicated git worktree. Implement the task end-to-end; your changes are committed and reviewed automatically after you finish.",
} as const;

// Patterns hinting a bash command would write or mutate state (filesystem, git,
// packages, permissions). Conservative: analyze is a read-only mode, so reject
// anything that looks like it writes instead of merely reading.
const READONLY_WRITE_PATTERNS =
	/(?:\b(?:>|>>|\btouch\b|\bmkdir\b|\bnpm\s+i(?:nstall)?\b|\bpip\s+i(?:nstall)?\b|\bgit\s+(?:add|commit|push|reset|checkout|switch)\b|\bsudo\b|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\brmdir\b|\btee\b|\bdd\b|\bsed\s+-i\b|\bapt(?:-get)?\s+(?:install|update|remove|purge)\b|\byum\s+(?:install|remove|update)\b)\b)/i;

/** Inject a marker the user-side gate (or shell scripts) can check to keep the
 * read-only bash environment honest. */
function buildSubagentEnv(readOnly: boolean): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (readOnly) env.PI_SUBAGENT_READONLY = "1";
	return env;
}

/** Wrap a bash-ish tool so that in analyze mode any write-like command is
 * rejected with a clear read-only message instead of being executed. Read-only
 * commands pass through unchanged. */
function wrapReadonlyTool(tool: AgentHarnessTool<ExecutionToolContext>): AgentHarnessTool<ExecutionToolContext> {
	const originalExecute = tool.execute.bind(tool);
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, context) => {
			const command = (params as Record<string, unknown>)?.command;
			const mutated = typeof command !== "string" || !command.trim() || READONLY_WRITE_PATTERNS.test(command);
			if (!mutated) {
				return originalExecute(toolCallId, params, signal, onUpdate, context);
			}
			return {
				content: [
					{
						type: "text",
						text:
							"[read-only mode] bash command rejected: it looks like it writes or mutates state.\n" +
							"You are a read-only agent — produce a report; do not modify anything.\n" +
							"For git inspection, use read-only commands (git status, git log, git show).",
					},
				],
				details: {},
			};
		},
	};
}

function buildSubagentPrompt(options: SubagentRunOptions): string {
	const readOnly = options.readOnly ?? false;
	const lines = readOnly
		? [
				"You are a read-only research sub-agent working in the SHARED project directory (like a read-only process sharing files with the parent).",
				"",
				`Directory: ${options.cwd}`,
				"",
				PATH_LINES.readOnly,
				"",
				"Rules:",
				"- Never modify anything; other agents may be reading the same files concurrently.",
				"- Do not ask questions — make reasonable decisions and complete the task fully.",
				"- Be concise in tool output usage: prefer targeted reads over dumping whole files.",
			]
		: [
				"You are a sub-agent executing a delegated task inside an isolated git worktree.",
				"",
				`Worktree: ${options.cwd} (branch ${options.branch})`,
				`The worktree is a full copy of the project at ${options.projectRoot}.`,
				"",
				PATH_LINES.write,
				"",
				"Rules:",
				"- Work only inside the worktree. Never touch files outside it.",
				"- Do not ask questions — make reasonable decisions and complete the task fully.",
				"- Do not run git commit/push; your changes are committed and reviewed automatically after you finish.",
				"- Be concise in tool output usage: prefer targeted reads over dumping whole files.",
			];
	if (options.depth + 1 < options.maxDepth) {
		lines.push(
			`- You may delegate independent subtasks via subagent_spawn (depth ${options.depth + 1} of ${options.maxDepth}).`,
		);
	}
	if (options.subagentInstructions) {
		lines.push(
			"",
			"Additional instructions from the parent runtime — these take precedence over anything conflicting above:",
			options.subagentInstructions,
		);
	}
	lines.push(
		"",
		readOnly
			? "Final message format: the report itself — findings, evidence (file:line), conclusions."
			: "Final message format: a concise report — what you changed, key decisions, blockers, and anything the parent agent must know.",
	);
	return lines.join("\n");
}

export async function runSubagent(options: SubagentRunOptions): Promise<SubagentRunResult> {
	const readOnly = options.readOnly ?? false;
	// Read-only enforcement: no edit/write tools, the bash tool is wrapped so
	// write-like commands are rejected, and the shell env carries
	// PI_SUBAGENT_READONLY=1 for the user-side gate.
	const env = new NodeExecutionEnv({ cwd: options.cwd, shellEnv: buildSubagentEnv(readOnly) });

	const baseTools: AgentHarnessTool<ExecutionToolContext>[] = readOnly
		? [createBashTool(), createReadTool()]
		: [createBashTool(), createReadTool(), createEditTool(), createWriteTool()];
	if (options.childTools && options.depth + 1 < options.maxDepth) {
		baseTools.push(...options.childTools(options.depth + 1, options.id));
	}
	// Wrap only the bash tool on the read-only path to enforce read-only semantics.
	const wrappedTools: AgentHarnessTool<ExecutionToolContext>[] = readOnly
		? baseTools.map((tool) => (tool.name === "bash" ? wrapReadonlyTool(tool) : tool))
		: baseTools;
	// The Agent runtime has no per-execution context slot; close over the
	// worktree env instead.
	const tools: AgentTool[] = wrappedTools.map((tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		async execute(toolCallId, params, signal, onUpdate) {
			const result = await tool.execute(toolCallId, params, signal, onUpdate, { env });
			return { content: result.content, details: result.details };
		},
	}));

	const agent = new Agent({
		initialState: {
			model: options.model,
			systemPrompt: buildSubagentPrompt(options),
			thinkingLevel: options.thinkingLevel ?? "off",
			tools,
		},
		streamFn: (model, context, streamOptions) =>
			options.modelRuntime.streamSimple(
				model,
				context,
				streamOptions as Parameters<typeof options.modelRuntime.streamSimple>[2],
			),
	});
	options.onAgentCreated?.(agent);

	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start" && options.onProgress) {
			const args = event.args as Record<string, unknown> | undefined;
			const target =
				(typeof args?.path === "string" && args.path) ||
				(typeof args?.command === "string" && args.command.substring(0, 60)) ||
				"";
			options.onProgress(`${event.toolName}${target ? ` ${target}` : ""}`);
		}
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
			const u = event.message.usage;
			usage.input += u.input;
			usage.output += u.output;
			usage.cacheRead += u.cacheRead;
			usage.cacheWrite += u.cacheWrite;
			usage.totalTokens += u.totalTokens;
			usage.cost.input += u.cost.input;
			usage.cost.output += u.cost.output;
			usage.cost.cacheRead += u.cost.cacheRead;
			usage.cost.cacheWrite += u.cost.cacheWrite;
			usage.cost.total += u.cost.total;
		}
	});

	if (options.signal) {
		const signal = options.signal;
		if (signal.aborted) {
			agent.abort();
		} else {
			signal.addEventListener("abort", () => agent.abort(), { once: true });
		}
	}

	await agent.prompt(options.task);

	const final = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
	if (!final) {
		throw new Error("Sub-agent run completed without an assistant message");
	}
	return {
		result: contentText(final.content, "").trim(),
		usage: {
			input: usage.input,
			output: usage.output,
			cost: usage.cost.total,
		},
		stopReason: final.stopReason,
		errorMessage: final.stopReason === "error" ? final.errorMessage : undefined,
	};
}
