/**
 * ssh (pi-ex): persistent SSH connections + remote exec/scp tools, migrated
 * from pi-ex core's SshIntegration.
 *
 * The integration class lives in lib/integration.ts unchanged apart from its
 * context interface; this entry adapts ExtensionContext to it (per session,
 * keyed by SessionManager) and registers the tools, the /ssh command, and
 * the tool_call gates (sync-timeout cap, sshpass/ssh-in-bash blocking).
 */
import type { ExtensionAPI, ExtensionContext, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TimeoutParamSchema } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SshIntegration, type SshIntegrationContext, SSH_TOOL_META } from "./lib/integration.ts";

const instances = new WeakMap<SessionManager, SshIntegration>();

function instanceFor(ctx: ExtensionContext): SshIntegration {
	const sm = ctx.sessionManager as unknown as SessionManager;
	let inst = instances.get(sm);
	if (!inst) {
		const ictx: SshIntegrationContext = {
			cwd: ctx.cwd,
			sessionManager: ctx.sessionManager,
			getUI: () => (ctx.hasUI ? ctx.ui : undefined),
			sendFollowUp: (text) => ctx.sendUserMessage(text, { triggerTurn: true, deliverAs: "followUp" }),
		};
		inst = new SshIntegration(ictx);
		instances.set(sm, inst);
	}
	return inst;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Construct eagerly so notifications route to this session immediately.
		instanceFor(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		instanceFor(ctx).onShutdown();
	});

	const toolNames = ["ssh_exec", "ssh_status", "scp_to_remote", "scp_from_remote"] as const;
	const schemas = {
		ssh_exec: Type.Object({
			host: Type.String({ description: "SSH host alias" }),
			command: Type.String({ description: "Command to execute on the remote server" }),
			timeout: Type.Optional(TimeoutParamSchema),
			background: Type.Optional(
				Type.Boolean({
					description: "Run in background via nohup on remote. Returns log path immediately (default: false)",
				}),
			),
		}),
		ssh_status: Type.Object({}),
		scp_to_remote: Type.Object({
			host: Type.String({ description: "SSH host alias" }),
			localPath: Type.String({ description: "Local file path" }),
			remotePath: Type.String({ description: "Remote destination path (e.g. '/data/file.pt' or '/data/')" }),
		}),
		scp_from_remote: Type.Object({
			host: Type.String({ description: "SSH host alias" }),
			remotePath: Type.String({ description: "Remote file path" }),
			localPath: Type.String({ description: "Local destination path" }),
		}),
	} as const;

	for (const name of toolNames) {
		const meta = SSH_TOOL_META[name];
		pi.registerTool({
			name,
			label: meta.label,
			description: meta.description,
			promptSnippet: "promptSnippet" in meta ? meta.promptSnippet : undefined,
			promptGuidelines: "promptGuidelines" in meta ? [...meta.promptGuidelines] : undefined,
			parameters: schemas[name],
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const def = instanceFor(ctx).getToolDefinitions().find((d) => d.name === name);
				if (!def) throw new Error(`ssh tool ${name} unavailable`);
				return def.execute(toolCallId, params as never, signal, onUpdate, ctx as never);
			},
		} as unknown as ToolDefinition);
	}

	pi.registerCommand("ssh", {
		description: "SSH connection manager: /ssh user@host [command] | status | sudo <host> | close <host>",
		handler: async (args, ctx) => {
			await instanceFor(ctx).handleCommand(args);
		},
	});

	// Tool-call gates (migrated from the integration's onToolCall).
	pi.on("tool_call", (event) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		// Block synchronous tool timeouts >300s — use background mode instead.
		if (event.toolName === "bash" || event.toolName === "ssh_exec") {
			const raw = input.timeout;
			let seconds: number | undefined;
			if (typeof raw === "number") seconds = raw;
			else if (typeof raw === "string") {
				const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw.trim());
				if (m) {
					const f = m[2] === "ms" ? 0.001 : m[2] === "s" ? 1 : m[2] === "m" ? 60 : 3600;
					seconds = Number(m[1]) * f;
				}
			}
			if (seconds !== undefined && seconds > 300 && !input.background) {
				return {
					block: true,
					reason: `Timeout ${Math.round(seconds)}s exceeds max synchronous limit (300s). Use background:true or a timeout <= 300 (seconds).`,
				};
			}
		}
		if (event.toolName !== "bash") return undefined;
		const cmd = (input.command as string) || "";
		if (/\bsshpass\b/.test(cmd)) {
			return { block: true, reason: "sshpass blocked. Use ssh_exec or scp_to_remote/scp_from_remote." };
		}
		const words = cmd.split(/\s+/);
		const idx = words.findIndex((w) => /(?:^|\/)(ssh|sshpass|scp|sftp|rsync)$/.test(w));
		if (idx < 0) return undefined;
		const target = words.slice(idx, idx + 12).join(" ");
		if (!/\S+@\S+/.test(target)) return undefined;
		const hostMatch = target.match(/\S+@(?:\[)?([\w.-]+)/);
		if (hostMatch && /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/.test(hostMatch[1])) return undefined;
		return {
			block: true,
			reason: "Remote ssh/scp/rsync blocked. Use ssh_exec (commands) or scp_to_remote/scp_from_remote (files).",
		};
	});
}
