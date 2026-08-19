/**
 * SSH — persistent multiplexed connections as a core integration.
 *
 * Tools: ssh_exec, ssh_status, scp_to_remote, scp_from_remote.
 * Command: /ssh (interactive mode).
 * Also gates tool calls: blocks raw remote ssh/scp/rsync in bash and
 * synchronous timeouts over 300s.
 */
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { TimeoutParamSchema, timeoutToMs } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSshConnectionStore, parseSshArgs, type SshConnectionStore, spawnAsync } from "./store.ts";

/** Minimal UI surface the integration uses (masked sudo input, notify, status, widgets). */
export interface SshUi {
	input(title: string, placeholder?: string, opts?: { masked?: boolean }): Promise<string | undefined>;
	notify(message: string, level: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

/** Per-session context the extension adapter provides. */
export interface SshIntegrationContext {
	readonly cwd: string;
	readonly sessionManager: ExtensionContext["sessionManager"];
	getUI(): SshUi | undefined;
	sendFollowUp?(text: string): void;
}

const MAX_SYNC_TIMEOUT_MS = 300_000;

/** Normalize any tool's timeout parameter (seconds number, suffixed string, or { value, unit }) to seconds. */
function timeoutToSeconds(raw: unknown): number | undefined {
	try {
		return timeoutToMs(raw as never) / 1000;
	} catch {
		return undefined;
	}
}

const GIT_HOSTING_DOMAINS =
	/(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|gitee\.com|gitcode\.com|sr\.ht)$/i;

export class SshIntegration {
	readonly id = "ssh";
	readonly store: SshConnectionStore;

	private readonly ctx: SshIntegrationContext;
	private readonly unsubscribe: () => void;
	readonly sessionId: string;

	/** Sudo passwords are per-session (connections are shared, passwords are not). */
	private sudoPasswordKey(connKey: string): string {
		return `${this.sessionId}:${connKey}`;
	}

	/**
	 * Prompt the USER (never the model) for a sudo password for a connection.
	 * Shared by the /ssh sudo command and the ssh_exec tool so the password
	 * flow stays identical in both paths. Returns the password on success, or
	 * a status explaining why no password was captured.
	 */
	async promptSudoPassword(
		ui: Pick<SshUi, "input"> | undefined,
		connAlias: string,
	): Promise<{ status: "ok"; password: string } | { status: "no-ui" } | { status: "cancelled" }> {
		if (!ui) return { status: "no-ui" };
		const password = await ui.input(
			`sudo password for ${connAlias} (memory only, never shown or persisted)`,
			undefined,
			{ masked: true },
		);
		if (!password) return { status: "cancelled" };
		return { status: "ok", password };
	}
	private pendingRemoteResults: string[][] = [];
	private remoteBatchTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: SshIntegrationContext, store?: SshConnectionStore) {
		this.ctx = ctx;
		this.store = store ?? getSshConnectionStore();
		// Stable per session file: remote-task notifications must still route to
		// this session after a pi restart (a per-process random id would leave
		// them addressed to a dead session).
		this.sessionId =
			ctx.sessionManager?.getSessionId?.() ?? `ssh-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
		this.unsubscribe = this.store.subscribe(
			{
				onStatus: (key, text) => this.ctx.getUI()?.setStatus(key, text),
				onNotify: (message, level) => this.ctx.getUI()?.notify(message, level),
				onRemoteTaskMessage: (lines) => {
					this.pendingRemoteResults.push(lines);
					if (this.remoteBatchTimer) clearTimeout(this.remoteBatchTimer);
					this.remoteBatchTimer = setTimeout(() => {
						this.remoteBatchTimer = null;
						this.flushRemoteBatch();
					}, 1000);
				},
			},
			this.sessionId,
		);
	}

	getToolDefinitions(): ToolDefinition[] {
		return [
			this.createExecTool() as ToolDefinition,
			this.createStatusTool() as ToolDefinition,
			this.createScpToTool() as ToolDefinition,
			this.createScpFromTool() as ToolDefinition,
		];
	}

	getDefaultActiveToolNames(): string[] {
		return ["ssh_exec", "ssh_status", "scp_to_remote", "scp_from_remote"];
	}

	onToolCall(toolName: string, input: Record<string, unknown>): { block: true; reason: string } | undefined {
		// Block synchronous tool timeouts >300s — use background mode instead.
		// Only bash and ssh_exec are synchronous: other tools' timeout params
		// are runtime caps, not synchronous limits (bg_spawn: task runtime,
		// default 12h; subagent_spawn: sub-agent runtime, default 2h).
		if (toolName === "bash" || toolName === "ssh_exec") {
			const effectiveSeconds = timeoutToSeconds(input?.timeout);
			if (effectiveSeconds !== undefined && effectiveSeconds > 300 && !input?.background) {
				return {
					block: true,
					reason: `Timeout ${Math.round(effectiveSeconds)}s exceeds max synchronous limit (300s). Use background:true or a timeout <= 300 (seconds).`,
				};
			}
		}

		if (toolName !== "bash") return undefined;
		const cmd = (input?.command as string) || "";
		if (/\bsshpass\b/.test(cmd)) {
			return { block: true, reason: "sshpass blocked. Use ssh_exec or scp_to_remote/scp_from_remote." };
		}
		const words = cmd.split(/\s+/);
		const idx = words.findIndex((w) => /(?:^|\/)(ssh|sshpass|scp|sftp|rsync)$/.test(w));
		if (idx < 0) return undefined;
		const target = words.slice(idx, idx + 12).join(" ");
		if (!/\S+@\S+/.test(target)) return undefined;
		// Git-over-SSH to hosting providers is normal VCS usage, not ad-hoc
		// server management — leave it alone.
		const hostMatch = target.match(/\S+@(?:\[)?([\w.-]+)/);
		if (hostMatch && GIT_HOSTING_DOMAINS.test(hostMatch[1])) return undefined;
		return {
			block: true,
			reason: "Remote ssh/scp/rsync blocked. Use ssh_exec (commands) or scp_to_remote/scp_from_remote (files).",
		};
	}

	// ── /ssh command support ─────────────────────────────────────────────

	/**
	 * Programmatic sudo-password setup for a connection: resolve the connection,
	 * prompt the USER (never the model) for the (masked) sudo password, store it
	 * in-memory, prime the remote shell, and validate with `sudo -v`. The web
	 * runtime (`ssh_sudo`) calls this directly; `handleCommand`'s sudo branch
	 * delegates to it so the TUI flow stays identical.
	 */
	async sudo(
		host: string,
	): Promise<
		| { status: "ok" }
		| { status: "no-connection" }
		| { status: "no-ui" | "cancelled" }
		| { status: "failed"; message: string }
	> {
		const ui = this.ctx.getUI();
		const conn = await this.store.findConnection(host);
		if (!conn) return { status: "no-connection" };
		const prompt = await this.promptSudoPassword(ui, conn.alias);
		if (prompt.status !== "ok") return { status: prompt.status };
		this.store.setSudoPassword(this.sudoPasswordKey(conn.key), prompt.password);
		try {
			await this.store.primeSudo(conn, true, this.sudoPasswordKey(conn.key));
			const check = await this.store.shellExec(conn, "sudo -v && echo SUDO_OK", 15_000);
			if (check.includes("SUDO_OK")) {
				return { status: "ok" };
			}
			return {
				status: "failed",
				message: `sudo validation failed on ${conn.alias} — the password may be wrong. Re-run /ssh sudo.`,
			};
		} catch (err) {
			return {
				status: "failed",
				message: `Failed to set up sudo on ${conn.alias}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async handleCommand(args: string): Promise<void> {
		const ui = this.ctx.getUI();
		const trimmed = args.trim();
		if (!trimmed) {
			ui?.notify(
				"/ssh [-p PORT] [-J jump] user@host [command]  |  status  |  sudo <host>  |  close <host>\n" +
					"Jump hosts (ProxyJump) in ~/.ssh/config work out of the box: /ssh <alias>",
				"warning",
			);
			return;
		}
		if (trimmed === "status") {
			await this.store.syncFromDisk();
			const lines = await this.store.statusLines();
			if (lines.length === 0) {
				ui?.notify("No connections.", "info");
			} else {
				ui?.setWidget?.("ssh-status", lines);
			}
			return;
		}
		if (trimmed.startsWith("close ")) {
			this.store.close(trimmed.slice(6).trim());
			return;
		}
		if (trimmed.startsWith("sudo")) {
			const host = trimmed.slice(4).trim();
			if (!host) {
				ui?.notify("Usage: /ssh sudo <host> — store the sudo password for a connection (memory only).", "warning");
				return;
			}
			const result = await this.sudo(host);
			switch (result.status) {
				case "ok":
					ui?.notify(`sudo enabled for ${host}.`, "info");
					return;
				case "no-connection":
					ui?.notify(`No connection matching "${host}". Connect first: /ssh ${host}`, "error");
					return;
				case "no-ui":
				case "cancelled":
					ui?.notify("Cancelled or no UI available — sudo password not set.", "info");
					return;
				case "failed":
					ui?.notify(result.message, "error");
					return;
			}
		}
		const parsed = parseSshArgs(trimmed);
		if (!parsed) {
			ui?.notify("Invalid syntax.", "error");
			return;
		}
		if (parsed.command) {
			const result = await this.store.runRemote(
				parsed.alias,
				parsed.user,
				parsed.hostname,
				parsed.port,
				parsed.command,
				parsed.jump,
			);
			if (result !== undefined && ui) {
				ui.setWidget(
					"ssh-result",
					[
						`┌─ ${parsed.user}@${parsed.hostname}:${parsed.port} — ${parsed.command.substring(0, 40)}`,
						...result
							.split("\n")
							.slice(0, 8)
							.map((l: string) => `│ ${l.substring(0, 100)}`),
						result.split("\n").length > 8 ? "│ ... (truncated)" : "",
					].filter(Boolean),
				);
			}
		} else {
			await this.store.connect(
				parsed.alias,
				parsed.user,
				parsed.hostname,
				parsed.port,
				parsed.jump,
				parsed.configProxy,
			);
		}
	}

	// ── tools ────────────────────────────────────────────────────────────

	private createExecTool() {
		const schema = Type.Object({
			host: Type.String({ description: "SSH host alias" }),
			command: Type.String({ description: "Command to execute on the remote server" }),
			timeout: Type.Optional(TimeoutParamSchema),
			background: Type.Optional(
				Type.Boolean({
					description: "Run in background via nohup on remote. Returns log path immediately (default: false)",
				}),
			),
		});
		const store = this.store;
		const sessionId = this.sessionId;
		const ctx = this.ctx;
		const definition: ToolDefinition<typeof schema> = {
			name: "ssh_exec",
			label: "SSH Execute",
			description:
				"Execute a command on a remote server via persistent SSH connection. " +
				"For long-running tasks (training, builds), use the background parameter: " +
				"the command runs via nohup on the remote server and returns immediately with a log path. " +
				"Use another ssh_exec to check progress via 'cat /tmp/task.log' or 'ps aux | grep PID'. " +
				"sudo commands are supported: the first time a command uses sudo, the user is prompted " +
				"for the sudo password (memory only, never shown to you or persisted); afterwards plain " +
				"`sudo ...` works. If sudo fails with a password error, ask the user to run /ssh sudo.",
			promptSnippet: "Run a command on a remote server through a persistent SSH connection.",
			promptGuidelines: [
				"MANDATORY: When the user asks to run commands on a remote server, you MUST use ssh_exec instead of bash.",
				"MANDATORY: Commands with timeout >300s are blocked — you MUST set background:true or use a timeout <= 300 (seconds).",
				"After background ssh_exec, use another ssh_exec to check progress: 'cat /tmp/task.log' or 'ps aux | grep PID'.",
				"Call ssh_status before running ssh_exec to verify the target host is connected.",
				"If no connection exists, tell the user: /ssh <host>",
			],
			parameters: schema,
			execute: async (_toolCallId, params, signal) => {
				if (/^\s*sleep\s+\d/.test(params.command)) {
					return {
						content: [
							{
								type: "text",
								text: "sleep is unnecessary. SSH connections are persistent — just run the actual command directly. For bg tasks, the system auto-polls and delivers results.",
							},
						],
						details: { blocked: true },
					};
				}
				if (!params.host?.trim()) {
					return {
						content: [{ type: "text", text: "Host is required — specify an SSH host alias." }],
						details: {},
						isError: true,
					};
				}
				const conn = await store.findConnection(params.host);
				if (!conn) {
					return {
						content: [
							{ type: "text", text: `No connection matching "${params.host}". Connect: /ssh ${params.host}` },
						],
						details: {},
						isError: true,
					};
				}
				if (await store.dropIfStale(conn)) {
					return {
						content: [{ type: "text", text: `Connection stale. Reconnect: /ssh ${conn.alias}` }],
						details: {},
						isError: true,
					};
				}
				// sudo support: if the command needs sudo and no password is stored
				// for this host, ask the USER (never the model) for it on demand.
				if (/\bsudo\b/.test(params.command) && !store.hasSudoPassword(this.sudoPasswordKey(conn.key))) {
					const prompt = await this.promptSudoPassword(ctx.getUI(), conn.alias);
					if (prompt.status === "no-ui") {
						return {
							content: [
								{
									type: "text",
									text: `Command requires sudo but no sudo password is stored for ${conn.alias}. Ask the user to run: /ssh sudo ${conn.alias}`,
								},
							],
							details: {},
							isError: true,
						};
					}
					if (prompt.status === "cancelled") {
						return {
							content: [
								{
									type: "text",
									text: "sudo password not provided (user cancelled). Ask the user how to proceed — do not retry sudo blindly.",
								},
							],
							details: {},
							isError: true,
						};
					}
					store.setSudoPassword(this.sudoPasswordKey(conn.key), prompt.password);
				}
				if (/\bsudo\b/.test(params.command)) {
					try {
						// force: re-inject on every sudo command — sudoPrimed can drift
						// from the actual remote shell state (e.g. after a shell
						// restart or manual unset), and re-injection is one cheap
						// shell round-trip.
						await store.primeSudo(conn, true, this.sudoPasswordKey(conn.key));
					} catch (err) {
						return {
							content: [
								{
									type: "text",
									text: `Failed to set up sudo on ${conn.alias}: ${err instanceof Error ? err.message : String(err)}`,
								},
							],
							details: {},
							isError: true,
						};
					}
				}
				try {
					const effectiveTimeout = params.timeout ? timeoutToMs(params.timeout) : 120_000;
					if (effectiveTimeout > MAX_SYNC_TIMEOUT_MS && !params.background) {
						return {
							content: [
								{
									type: "text",
									text:
										`Timeout ${Math.round(effectiveTimeout / 1000)}s exceeds max synchronous limit (300s). Use one of:\n` +
										"- Set background: true to run as nohup on remote\n" +
										"- Or use a timeout <= 300 (seconds) for synchronous execution",
								},
							],
							details: { blocked: true },
						};
					}

					if (params.background === true) {
						const bg = await store.spawnRemoteBg(params.host, params.command, conn, sessionId);
						if (bg.deduplicated) {
							return {
								content: [
									{
										type: "text",
										text:
											`Background task already running on ${conn.key}.\n` +
											`Log: ${bg.logPath}\n` +
											`Check progress: ssh_exec("${params.host}", "tail -20 ${bg.logPath}")`,
									},
								],
								details: { logPath: bg.logPath, deduplicated: true },
							};
						}
						return {
							content: [
								{
									type: "text",
									text:
										`Background task started on ${conn.key}.\n` +
										`Log: ${bg.logPath}\n` +
										`Check progress: ssh_exec("${params.host}", "tail -20 ${bg.logPath}")\n` +
										`Read full log: ssh_exec("${params.host}", "cat '${bg.logPath}'")\n` +
										`The completion notice arrives automatically — you can rest the turn with wait() until then.`,
								},
							],
							details: { pid: bg.pid, logPath: bg.logPath },
						};
					}
					// Foreground path: every command runs under nohup on the remote so it
					// survives this ssh connection; the tool waits synchronously for up
					// to the timeout window (default 120s) and then hands the process to
					// the background poller, whose completion notice wakes the session.
					// This keeps simple commands natural (output returned directly) while
					// long tasks never block the turn past the window or lose their
					// completion signal.
					const waitWindow = Math.min(effectiveTimeout, MAX_SYNC_TIMEOUT_MS);
					const { logPath, pid } = await store.startRemoteNohup(conn, params.command);
					if (pid) {
						const waited = await store.waitRemoteProcess(conn, pid, logPath, waitWindow, signal);
						if (waited.finished) {
							return {
								content: [{ type: "text", text: waited.output ?? "(no output)" }],
								details: {},
							};
						}
						await store.monitorRunningRemoteTask(conn.key, conn, params.command, logPath, pid, sessionId);
					} else {
						// No pid captured: fall back to reading the log after the window.
						await new Promise((r) => setTimeout(r, 2_000));
					}
					return {
						content: [
							{
								type: "text",
								text:
									`Command still running on ${conn.key} after ${Math.round(waitWindow / 1000)}s — moved to background monitoring${pid ? "" : " (no pid captured; liveness is inferred from log growth)"}.\n` +
									`Log: ${logPath}\n` +
									`Check progress: ssh_exec("${params.host}", "tail -20 ${logPath}")\n` +
									`The completion notice arrives automatically — you can rest the turn with wait() until then.`,
							},
						],
						details: { logPath, pid },
					};
				} catch (e: any) {
					return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	private createStatusTool() {
		const schema = Type.Object({});
		const store = this.store;
		const definition: ToolDefinition<typeof schema> = {
			name: "ssh_status",
			label: "SSH Status",
			description: "Check active SSH connections.",
			promptSnippet: "Check active SSH connections before running remote commands.",
			promptGuidelines: [
				"Call ssh_status before ssh_exec to verify the target host is connected.",
				"If not connected, tell the user: /ssh <host>",
			],
			parameters: schema,
			async execute() {
				await store.syncFromDisk();
				const conns = store.listConnections();
				if (conns.length === 0) {
					return { content: [{ type: "text", text: "No active SSH connections." }], details: {} };
				}
				const lines = ["Active SSH connections:"];
				for (const c of conns) {
					lines.push(`  ${(await store.isConnected(c.key)) ? "●" : "○"} ${c.key}`);
				}
				return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
			},
		};
		return definition;
	}

	private createScpToTool() {
		const schema = Type.Object({
			host: Type.String({ description: "SSH host alias" }),
			localPath: Type.String({ description: "Local file path" }),
			remotePath: Type.String({ description: "Remote destination path (e.g. '/data/file.pt' or '/data/')" }),
		});
		const store = this.store;
		const definition: ToolDefinition<typeof schema> = {
			name: "scp_to_remote",
			label: "SCP to Remote",
			description: "Copy a local file to a remote server via persistent SSH connection (no password needed).",
			parameters: schema,
			async execute(_toolCallId, params) {
				await store.syncFromDisk();
				const conn = await store.findConnection(params.host);
				if (!conn) {
					return {
						content: [{ type: "text", text: `No connection. Connect: /ssh ${params.host}` }],
						details: {},
						isError: true,
					};
				}
				if (!(await store.isConnected(conn.key))) {
					return { content: [{ type: "text", text: "Connection stale. Reconnect." }], details: {}, isError: true };
				}
				if (!existsSync(params.localPath)) {
					return {
						content: [{ type: "text", text: `Local file not found: ${params.localPath}` }],
						details: {},
						isError: true,
					};
				}
				if (statSync(params.localPath).isDirectory()) {
					return {
						content: [{ type: "text", text: `Local path is a directory, not a file: ${params.localPath}` }],
						details: {},
						isError: true,
					};
				}
				try {
					const result = await spawnAsync(
						"scp",
						[
							"-o",
							`ControlPath=${conn.socket}`,
							"-o",
							"ConnectTimeout=5",
							"-o",
							"LogLevel=ERROR",
							params.localPath,
							`${conn.alias}:${params.remotePath}`,
						],
						{ timeout: 300_000 },
					);
					if (result.status !== 0) throw new Error(result.stderr || `scp exited with code ${result.status}`);
					conn.lastUse = Date.now();
					return {
						content: [
							{
								type: "text",
								text: `Copied: ${params.localPath} → ${conn.alias}:${params.remotePath}\n${result.stdout || "OK"}`,
							},
						],
						details: {},
					};
				} catch (e: any) {
					return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	private createScpFromTool() {
		const schema = Type.Object({
			host: Type.String({ description: "SSH host alias" }),
			remotePath: Type.String({ description: "Remote file path" }),
			localPath: Type.String({ description: "Local destination path" }),
		});
		const store = this.store;
		const definition: ToolDefinition<typeof schema> = {
			name: "scp_from_remote",
			label: "SCP from Remote",
			description: "Copy a file from a remote server to local via persistent SSH connection (no password needed).",
			parameters: schema,
			async execute(_toolCallId, params) {
				await store.syncFromDisk();
				const conn = await store.findConnection(params.host);
				if (!conn) {
					return {
						content: [{ type: "text", text: `No connection. Connect: /ssh ${params.host}` }],
						details: {},
						isError: true,
					};
				}
				if (!(await store.isConnected(conn.key))) {
					return { content: [{ type: "text", text: "Connection stale. Reconnect." }], details: {}, isError: true };
				}
				try {
					const destDir = dirname(params.localPath) || ".";
					if (!existsSync(destDir)) {
						return {
							content: [{ type: "text", text: `Local destination directory not found: ${destDir}` }],
							details: {},
							isError: true,
						};
					}
				} catch {
					/* let scp report the error */
				}
				try {
					const result = await spawnAsync(
						"scp",
						[
							"-o",
							`ControlPath=${conn.socket}`,
							"-o",
							"ConnectTimeout=5",
							"-o",
							"LogLevel=ERROR",
							`${conn.alias}:${params.remotePath}`,
							params.localPath,
						],
						{ timeout: 300_000 },
					);
					if (result.status !== 0) throw new Error(result.stderr || `scp exited with code ${result.status}`);
					conn.lastUse = Date.now();
					return {
						content: [
							{
								type: "text",
								text: `Copied: ${conn.alias}:${params.remotePath} → ${params.localPath}\n${result.stdout || "OK"}`,
							},
						],
						details: {},
					};
				} catch (e: any) {
					return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	onSessionStart(): void {
		void this.store.recoverRemoteTasks();
	}

	onShutdown(): void {
		if (this.remoteBatchTimer) clearTimeout(this.remoteBatchTimer);
		// Deliver any pending remote-task results instead of dropping them, and
		// scrub this session's sudo passwords from the shared store.
		this.flushRemoteBatch();
		this.store.deleteSessionSudoPasswords(this.sessionId);
		this.unsubscribe();
	}

	private flushRemoteBatch(): void {
		const batches = this.pendingRemoteResults.splice(0);
		if (batches.length === 0) return;
		if (batches.length === 1) {
			this.ctx.sendFollowUp?.(batches[0].join("\n"));
		} else {
			const merged = [`${batches.length} background tasks completed:`, ""];
			for (const b of batches) {
				// Keep the header, the command, the log pointer, and a truncated
				// output tail — dropping them makes the batch unreadable.
				const kept = b.map((line, i) => {
					if (i === 0 || /^Command:|^Log/.test(line)) return line;
					if (line.startsWith("Output:"))
						return line.substring(0, 500) + (line.length > 500 ? "\n… (truncated)" : "");
					return null;
				});
				merged.push(kept.filter((l) => l !== null).join("\n"), "");
			}
			this.ctx.sendFollowUp?.(merged.join("\n"));
		}
	}
}

/** Static model-facing text for the ssh tools (used by the extension's proxies). */
export const SSH_TOOL_META = {
	ssh_exec: {
		label: "SSH Execute",
		description:
			"Execute a command on a remote server via persistent SSH connection. " +
			"For long-running tasks (training, builds), use the background parameter: " +
			"the command runs via nohup on the remote server and returns immediately with a log path. " +
			"Use another ssh_exec to check progress via 'cat /tmp/task.log' or 'ps aux | grep PID'. " +
			"sudo commands are supported: the first time a command uses sudo, the user is prompted " +
			"for the sudo password (memory only, never shown to you or persisted); afterwards plain " +
			"`sudo ...` works. If sudo fails with a password error, ask the user to run /ssh sudo.",
		promptSnippet: "Run a command on a remote server through a persistent SSH connection.",
		promptGuidelines: [
			"MANDATORY: When the user asks to run commands on a remote server, you MUST use ssh_exec instead of bash.",
			"MANDATORY: Commands with timeout >300s are blocked — you MUST set background:true or use a timeout <= 300 (seconds).",
			"After background ssh_exec, use another ssh_exec to check progress: 'cat /tmp/task.log' or 'ps aux | grep PID'.",
			"Call ssh_status before running ssh_exec to verify the target host is connected.",
			"If no connection exists, tell the user: /ssh <host>",
		],
	},
	ssh_status: {
		label: "SSH Status",
		description: "Check active SSH connections.",
		promptSnippet: "Check active SSH connections before running remote commands.",
		promptGuidelines: [
			"Call ssh_status before ssh_exec to verify the target host is connected.",
			"If not connected, tell the user: /ssh <host>",
		],
	},
	scp_to_remote: {
		label: "SCP To Remote",
		description: "Copy a local file to a remote server via persistent SSH connection (no password needed).",
	},
	scp_from_remote: {
		label: "SCP From Remote",
		description: "Copy a file from a remote server to local via persistent SSH connection (no password needed).",
	},
} as const;
