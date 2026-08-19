/**
 * SSH connection store — persistent multiplexed SSH connections.
 *
 * Process-global singleton (shared by every session in the process, and
 * interoperable with other pi processes via the shared ControlMaster socket
 * directory). Commands run through a single persistent shell per connection;
 * long tasks are backgrounded on the remote side via nohup.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCKET_DIR = join(homedir(), ".ssh", "pi-sockets");
const REMOTE_TASKS_FILE = join(SOCKET_DIR, "remote-tasks.json");
/** Maps connection key → all known aliases (ssh-config Host names etc.). */
const ALIASES_FILE = join(SOCKET_DIR, "aliases.json");
const MAX_REMOTE_TASK_AGE_MS = 60 * 60 * 1000;

interface PendingEntry {
	resolve: (v: string) => void;
	reject: (e: Error) => void;
	rand: string;
	timer: ReturnType<typeof setTimeout> | null;
	onProcExit: (code: number | null) => void;
	onStdinError: (err: Error) => void;
	onDrain: (() => void) | undefined;
	bufAtWrite: string;
}

export interface SshConnection {
	key: string;
	/** Display alias (first known). */
	alias: string;
	/** All known aliases (lowercase), including ssh-config Host names. */
	aliases: Set<string>;
	socket: string;
	sshTarget: string;
	proc: ChildProcess | null;
	buf: string;
	pending: Map<number, PendingEntry>;
	reqId: number;
	startTime: number;
	lastUse: number;
	/** True once the sudo helper (password variable + sudo function) has been
	 * injected into the current remote shell. Reset when the shell respawns. */
	sudoPrimed?: boolean;
}

export interface RemoteBgTask {
	host: string;
	logPath: string;
	cmd: string;
	pid: string | null;
	startTime: number;
	/** Session that spawned this task. Only that session receives completion notification. */
	sessionId?: string;
	/** All sessions that share this task (dedup hits adopt additional sessions). */
	sessionIds?: string[];
}

export interface SshStoreEvents {
	/** Status line updates (key "ssh-bg" or "ssh-<connKey>"). */
	onStatus(key: string, text: string | undefined): void;
	/** User-facing notification. */
	onNotify(message: string, level: "info" | "warning" | "error"): void;
	/** A remote background task reached a terminal state; deliver its result. */
	onRemoteTaskMessage(lines: string[]): void;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Escape a value for safe interpolation inside a double-quoted shell string. */
export function shellEscapeDQ(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

export function connKey(user: string, hostname: string, port: number, jump?: string): string {
	const base = `${user}@${hostname}:${port}`;
	if (!jump) return base;
	// The same endpoint reached via different jump hosts (or directly) must
	// be distinct connections — they take different network paths and cannot
	// share a ControlMaster socket.
	const slug = jump.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return `${base}+via+${slug}`;
}

function socketPath(key: string): string {
	return join(SOCKET_DIR, `${key}.sock`);
}

/** Redact any line containing the sudo-prime command (it embeds the plaintext password). */
function sanitizeSudoPrime(text: string): string {
	if (!text.includes("__PI_SUDOPW")) return text;
	return text
		.split("\n")
		.map((line) => (line.includes("__PI_SUDOPW") ? "<redacted sudo-prime command>" : line))
		.join("\n");
}

function targetStr(alias: string, user: string, hostname: string, port: number, jump?: string): string {
	const jumpPart = jump ? `-J ${jump} ` : "";
	return alias !== hostname ? `${jumpPart}${alias}` : `${jumpPart}-p ${port} ${user}@${hostname}`;
}

function resolveSshConfig(host: string): { user: string; hostname: string; port: number; proxy?: string } | null {
	try {
		const result = spawnSync("ssh", ["-G", host], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5_000,
		});
		const out = (result.stdout || "") + (result.stderr || "");
		const cfg: Record<string, string> = {};
		for (const line of out.split("\n")) {
			const s = line.indexOf(" ");
			if (s > 0) cfg[line.substring(0, s)] = line.substring(s + 1);
		}
		if (cfg.hostname) {
			return {
				user: cfg.user || "root",
				hostname: cfg.hostname,
				port: parseInt(cfg.port || "22", 10),
				proxy: cfg.proxyjump || cfg.proxycommand || undefined,
			};
		}
		return null;
	} catch {
		return null;
	}
}

export interface ParsedSshArgs {
	alias: string;
	user: string;
	hostname: string;
	port: number;
	command: string;
	/** Jump host from -J (e.g. user@bastion). Undefined when the target is
	 * direct or the jump comes from ssh config (ProxyJump on the alias). */
	jump?: string;
	/** ProxyJump/ProxyCommand from ssh config for this alias, if any. */
	configProxy?: string;
}

export function parseSshArgs(args: string): ParsedSshArgs | null {
	// SSH options that take a value — everything else is boolean
	const VALUE_FLAGS = new Set([
		"p",
		"i",
		"o",
		"l",
		"b",
		"c",
		"E",
		"F",
		"I",
		"J",
		"m",
		"Q",
		"w",
		"e",
		"O",
		"S",
		"D",
		"R",
		"L",
	]);
	const parts = args.trim().split(/\s+/);
	let user = "";
	let hostname = "";
	let port = 0;
	let command = "";
	let jump: string | undefined;
	let i = 0;
	while (i < parts.length) {
		const p = parts[i];
		if (p === "-p") {
			if (i + 1 < parts.length) {
				const v = parseInt(parts[i + 1], 10);
				if (!Number.isNaN(v)) {
					port = v;
					i += 2;
				} else {
					return null;
				}
			} else {
				return null;
			}
		} else if (p.startsWith("-")) {
			const flag = p.replace(/^-+/, "");
			if (flag.length > 1 && VALUE_FLAGS.has(flag[0])) {
				const value = flag.substring(1);
				if (flag[0] === "p") {
					const v = parseInt(value, 10);
					if (!Number.isNaN(v)) port = v;
				} else if (flag[0] === "l" && !user) {
					user = value;
				} else if (flag[0] === "J") {
					jump = value;
				}
				i += 1;
			} else if (VALUE_FLAGS.has(flag) && i + 1 < parts.length && !parts[i + 1].startsWith("-")) {
				const value = parts[i + 1];
				if (flag === "p") {
					const v = parseInt(value, 10);
					if (!Number.isNaN(v)) port = v;
				} else if (flag === "l" && !user) {
					user = value;
				} else if (flag === "J") {
					jump = value;
				}
				i += 2;
			} else {
				i += 1;
			}
		} else if (p.includes("@")) {
			const atIdx = p.lastIndexOf("@");
			user = p.substring(0, atIdx);
			const hostPart = p.substring(atIdx + 1);
			if (hostPart.includes(":")) {
				if (hostPart.startsWith("[")) {
					const closeBracket = hostPart.indexOf("]");
					if (closeBracket > 0) {
						hostname = hostPart.substring(0, closeBracket + 1);
						const afterBracket = hostPart.substring(closeBracket + 1);
						if (afterBracket.startsWith(":")) {
							const pt = parseInt(afterBracket.substring(1), 10);
							if (!Number.isNaN(pt)) port = port || pt;
						}
					} else {
						hostname = hostPart;
					}
				} else {
					const colonIdx = hostPart.lastIndexOf(":");
					hostname = hostPart.substring(0, colonIdx);
					const pt = parseInt(hostPart.substring(colonIdx + 1), 10);
					if (!Number.isNaN(pt)) port = port || pt;
					else hostname = hostPart;
				}
			} else {
				hostname = hostPart;
			}
			if (i + 1 < parts.length) command = parts.slice(i + 1).join(" ");
			i = parts.length;
		} else {
			hostname = p;
			if (i + 1 < parts.length) command = parts.slice(i + 1).join(" ");
			i = parts.length;
		}
	}
	if (!hostname) return null;
	const alias = hostname;
	let configProxy: string | undefined;
	const r = resolveSshConfig(hostname);
	if (r) {
		if (!user) user = r.user;
		hostname = r.hostname;
		if (!port) port = r.port;
		configProxy = r.proxy;
	}
	return { alias, user: user || "root", hostname, port: port || 22, command, jump, configProxy };
}

export function spawnAsync(
	cmd: string,
	args: string[],
	options: { timeout: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stdout.on("error", () => {});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.stderr.on("error", () => {});
		const timer = setTimeout(() => {
			// Kill the whole process group so descendant ssh/scp processes do not
			// survive the timeout (child.kill() alone only signals the parent).
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill();
				}
			} else {
				child.kill();
			}
			reject(new Error("timed out"));
		}, options.timeout);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ status: code, stdout, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

// ── store ───────────────────────────────────────────────────────────────────

export class SshConnectionStore {
	private readonly connections = new Map<string, SshConnection>();
	private readonly remoteTasks: RemoteBgTask[] = [];
	private readonly spawningRemoteBg = new Set<string>();
	private readonly pollRemoteActive = new Set<string>();
	/** Per-key handles for the connect() polling loop and its post-connect re-verify,
	 * so destroyConn/shutdown can cancel an in-flight connect attempt. */
	private readonly connectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly listeners = new Map<string, SshStoreEvents>();
	/** Aliases persisted across restarts (socket files only encode the key). */
	private readonly persistedAliases = new Map<string, string[]>();

	constructor() {
		if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });
		this.loadRemoteTasks();
		this.loadAliases();
	}

	subscribe(events: SshStoreEvents, id?: string): () => void {
		const listenerId = id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		this.listeners.set(listenerId, events);
		return () => {
			this.listeners.delete(listenerId);
		};
	}

	private emitStatus(key: string, text: string | undefined): void {
		for (const l of this.listeners.values()) {
			try {
				l.onStatus(key, text);
			} catch {
				/* ignore */
			}
		}
	}

	private emitNotify(message: string, level: "info" | "warning" | "error" = "info"): void {
		for (const l of this.listeners.values()) {
			try {
				l.onNotify(message, level);
			} catch {
				/* ignore */
			}
		}
	}

	private emitRemoteTaskMessage(lines: string[], sessionIds?: string[]): void {
		for (const [id, l] of this.listeners) {
			if (sessionIds && !sessionIds.includes(id)) continue;
			try {
				l.onRemoteTaskMessage(lines);
			} catch {
				/* ignore */
			}
		}
	}

	// ── remote task persistence ─────────────────────────────────────────

	private saveRemoteTasks(): void {
		try {
			mkdirSync(SOCKET_DIR, { recursive: true });
			writeFileSync(REMOTE_TASKS_FILE, JSON.stringify(this.remoteTasks, null, 2));
		} catch {
			/* best effort */
		}
	}

	private saveAliases(): void {
		try {
			mkdirSync(SOCKET_DIR, { recursive: true });
			writeFileSync(ALIASES_FILE, JSON.stringify(Object.fromEntries(this.persistedAliases), null, 2));
		} catch {
			/* best effort */
		}
	}

	private loadAliases(): void {
		try {
			if (existsSync(ALIASES_FILE)) {
				const data = JSON.parse(readFileSync(ALIASES_FILE, "utf-8")) as Record<string, string[]>;
				for (const [key, aliases] of Object.entries(data)) {
					if (Array.isArray(aliases))
						this.persistedAliases.set(
							key,
							aliases.map((a) => String(a).toLowerCase()),
						);
				}
			}
		} catch {
			/* best effort */
		}
	}

	private loadRemoteTasks(): void {
		try {
			if (existsSync(REMOTE_TASKS_FILE)) {
				const loaded = JSON.parse(readFileSync(REMOTE_TASKS_FILE, "utf-8"));
				if (Array.isArray(loaded)) {
					this.remoteTasks.length = 0;
					for (const t of loaded) this.remoteTasks.push(t);
				}
			}
		} catch {
			/* best effort */
		}
	}

	listConnections(): SshConnection[] {
		return [...this.connections.values()];
	}

	getConnection(key: string): SshConnection | undefined {
		return this.connections.get(key);
	}

	// ── connection liveness ─────────────────────────────────────────────

	async isConnected(key: string, quick = false): Promise<boolean> {
		let sock = socketPath(key);
		if (!existsSync(sock)) {
			const legacySock = join(SOCKET_DIR, `${key.replace(/[@:]/g, "_")}.sock`);
			if (existsSync(legacySock)) sock = legacySock;
			else return false;
		}
		const timeout = quick ? 2_000 : 5_000;
		try {
			const result = await spawnAsync("ssh", ["-o", `ControlPath=${sock}`, "-O", "check", "x"], { timeout });
			if (result.status === 0) return true;
			const combined = result.stdout + result.stderr;
			if (/master running/i.test(combined)) return true;
			try {
				rmSync(sock);
			} catch {
				/* ok */
			}
			return false;
		} catch {
			return false;
		}
	}

	private addConn(key: string, alias: string, sock: string, target: string): void {
		const aliases = new Set<string>([alias.toLowerCase(), key.toLowerCase()]);
		for (const a of this.persistedAliases.get(key) ?? []) aliases.add(a);
		this.connections.set(key, {
			key,
			alias,
			aliases,
			socket: sock,
			sshTarget: target,
			proc: null,
			buf: "",
			pending: new Map(),
			reqId: 0,
			startTime: Date.now(),
			lastUse: Date.now(),
		});
	}

	/** Record an additional alias for an existing connection and persist it. */
	private rememberAlias(conn: SshConnection, alias: string): void {
		const normalized = alias.toLowerCase();
		if (conn.aliases.has(normalized)) return;
		conn.aliases.add(normalized);
		this.persistedAliases.set(conn.key, [...conn.aliases]);
		this.saveAliases();
	}

	/** Connect by opening a terminal emulator for interactive auth, then poll for the master. */
	async connect(
		alias: string,
		user: string,
		hostname: string,
		port: number,
		jump?: string,
		configProxy?: string,
	): Promise<void> {
		const key = connKey(user, hostname, port, jump);
		const sock = socketPath(key);
		const sshTarget = targetStr(alias, user, hostname, port, jump);
		if (await this.isConnected(key)) {
			const existing = this.connections.get(key);
			if (!existing) {
				this.addConn(key, alias, sock, sshTarget);
			} else {
				// Reconnecting via a (possibly different) ssh-config alias —
				// remember it so ssh_exec can find this connection by that name.
				this.rememberAlias(existing, alias);
			}
			this.emitNotify(`Already connected to ${user}@${hostname}:${port}.`, "info");
			return;
		}
		if (existsSync(sock)) {
			try {
				rmSync(sock);
			} catch {
				/* ok */
			}
		}
		this.emitNotify(`Opening SSH to ${user}@${hostname}:${port}...`, "info");
		const displayHost = alias !== hostname ? `${alias} (${user}@${hostname}:${port})` : `${user}@${hostname}:${port}`;
		const termEnv = process.env.TERMINAL || "";
		const termCandidates = [termEnv, "alacritty", "kitty", "gnome-terminal", "xterm"].filter(Boolean);
		const termEmu =
			termCandidates.find((t) => {
				const r = spawnSync("which", [t], { stdio: "ignore" });
				return r.status === 0;
			}) || "xterm";
		const safeDisplayHost = shellEscapeDQ(displayHost);
		const safeSock = shellEscapeDQ(sock);
		const safeSshTarget = sshTarget
			.split(" ")
			.map((w) => `'${w.replace(/'/g, "'\\''")}'`)
			.join(" ");

		// Jump connections (ProxyJump/ProxyCommand/-J) die when the bootstrap
		// terminal closes: the proxy child lives in the window's process group,
		// and killing it breaks the mux master's transport. A "keeper" window
		// holds the connection open until the master dies or the user closes it.
		const isJump = jump !== undefined || configProxy !== undefined;
		const windowScript = isJump
			? `echo "Connecting to ${safeDisplayHost}..."; ` +
				`ssh -o ControlPath="${safeSock}" -o ControlMaster=auto -o ControlPersist=12h ` +
				`-o ServerAliveInterval=60 -o ServerAliveCountMax=5 ` +
				`-o StrictHostKeyChecking=accept-new -fN ${safeSshTarget} && ` +
				`echo "Connected! Keep this window open — it holds the jump connection." || ` +
				`{ echo "Auth failed."; read -p 'Press Enter...'; exit 1; }; ` +
				`while ssh -O check -o ControlPath="${safeSock}" x 2>/dev/null; do sleep 10; done; ` +
				`echo "Connection closed."; read -p 'Press Enter...'`
			: `echo "Connecting to ${safeDisplayHost}..."; ` +
				`ssh -o ControlPath="${safeSock}" -o ControlMaster=auto -o ControlPersist=12h ` +
				`-o ServerAliveInterval=60 -o ServerAliveCountMax=5 ` +
				`-o StrictHostKeyChecking=accept-new -fN ${safeSshTarget} && ` +
				`echo "Connected!" || echo "Auth failed."; read -p 'Press Enter...'`;

		const termProc = spawn(
			termEmu,
			[...(termEmu === "gnome-terminal" ? ["--", "bash", "-c"] : ["-e", "bash", "-c"]), windowScript],
			{ stdio: "ignore", detached: true },
		);
		let connectPolling = true;
		termProc.on("error", () => {
			connectPolling = false;
			this.clearConnectTimer(key);
			this.emitStatus(`ssh-${key}`, undefined);
			this.emitNotify(
				`Failed to open terminal (${termEmu} not found?). Use ssh from an external terminal.`,
				"warning",
			);
		});
		termProc.unref();
		this.emitStatus(`ssh-${key}`, "Waiting...");
		let tries = 0;
		const poll = async () => {
			if (!connectPolling) return;
			tries++;
			if (await this.isConnected(key)) {
				connectPolling = false;
				this.clearConnectTimer(key);
				this.addConn(key, alias, sock, sshTarget);
				this.rememberAlias(this.connections.get(key)!, alias);
				this.emitStatus(`ssh-${key}`, undefined);
				this.emitNotify("Connected.", "info");
				// Re-verify shortly after: over unstable links (jump chains,
				// reverse tunnels) the master can die within seconds. Surface
				// that instead of leaving a phantom "Connected." impression.
				const reverify = setTimeout(() => {
					void this.isConnected(key, true).then((alive) => {
						if (!alive) {
							this.connectTimers.delete(key);
							this.connections.delete(key);
							this.emitNotify(
								`Connection to ${key} dropped immediately after connecting — the link or a jump/reverse-tunnel hop is unstable.`,
								"warning",
							);
						}
					});
				}, 4000);
				this.connectTimers.set(key, reverify);
				return;
			}
			if (tries < 45) {
				// Interactive auth can involve multiple prompts (key passphrase,
				// jump-host password, target password) — allow ~90s, not 20s.
				this.emitStatus(`ssh-${key}`, `Waiting... (${tries * 2}s)`);
				this.scheduleConnectTimer(key, () => void poll(), 2000);
			} else {
				this.clearConnectTimer(key);
				this.emitStatus(`ssh-${key}`, undefined);
				this.emitNotify("Timeout.", "warning");
			}
		};
		this.scheduleConnectTimer(key, () => void poll(), 2000);
	}

	/** (Re)schedule a connect-related timer, replacing any prior handle for the key. */
	private scheduleConnectTimer(key: string, fn: () => void, ms: number): void {
		const prev = this.connectTimers.get(key);
		if (prev) clearTimeout(prev);
		this.connectTimers.set(key, setTimeout(fn, ms));
	}

	private clearConnectTimer(key: string): void {
		const t = this.connectTimers.get(key);
		if (t) {
			clearTimeout(t);
			this.connectTimers.delete(key);
		}
	}

	/** Run a one-off command over an existing connection (for /ssh host <cmd>). */
	async runRemote(
		alias: string,
		user: string,
		hostname: string,
		port: number,
		command: string,
		jump?: string,
	): Promise<string | undefined> {
		const key = connKey(user, hostname, port, jump);
		if (!(await this.isConnected(key))) {
			this.emitNotify(`No connection. /ssh ${alias} first.`, "warning");
			return undefined;
		}
		if (!this.connections.has(key))
			this.addConn(key, alias, socketPath(key), targetStr(alias, user, hostname, port, jump));
		const conn = this.connections.get(key)!;
		this.emitStatus(`ssh-${key}`, "running...");
		try {
			const result = await this.shellExec(conn, command, 120_000);
			conn.lastUse = Date.now();
			return result;
		} finally {
			this.emitStatus(`ssh-${key}`, undefined);
		}
	}

	close(target: string): void {
		const t = target.toLowerCase();
		if (!t) {
			this.emitNotify("Usage: /ssh close <host>. Provide a hostname or alias.", "warning");
			return;
		}
		for (const [key, c] of this.connections) {
			if (c.aliases.has(t) || c.key.toLowerCase() === t) {
				// destroyConn drops the sudo passwords and stops task pollers.
				this.destroyConn(key, c);
				return;
			}
		}
		const substringMatches: Array<[string, SshConnection]> = [];
		for (const [key, c] of this.connections) {
			if (c.key.toLowerCase().includes(t) || [...c.aliases].some((a) => a.includes(t))) {
				substringMatches.push([key, c]);
			}
		}
		if (substringMatches.length === 1) {
			const [key, c] = substringMatches[0];
			this.destroyConn(key, c);
			return;
		}
		if (substringMatches.length > 1) {
			const names = substringMatches.map(([, c]) => c.key).join(", ");
			this.emitNotify(
				`Ambiguous: "${target}" matches multiple connections (${names}). Be more specific.`,
				"warning",
			);
			return;
		}
		this.emitNotify(`No connection matching "${target}".`, "error");
	}

	private destroyConn(key: string, c: SshConnection): void {
		this.clearConnectTimer(key);
		if (c.proc) {
			try {
				if (c.sudoPrimed) {
					// Remove the remote askpass dir (holds the sudo password file)
					// before the shell dies. Raw stdin write + short grace window —
					// shellExec's pending machinery is about to be torn down.
					try {
						c.proc.stdin?.write('rm -rf "$__PI_SUDOPW_DIR"\n');
					} catch {
						/* connection already dead */
					}
					const proc = c.proc;
					setTimeout(() => {
						try {
							proc.kill();
						} catch {
							/* ok */
						}
					}, 300);
				} else {
					c.proc.kill();
				}
			} catch {
				/* ok */
			}
		}
		for (const [, p] of c.pending) {
			if (p.timer) clearTimeout(p.timer);
			try {
				p.reject(new Error("Connection closed"));
			} catch {
				/* ok */
			}
		}
		c.pending.clear();
		let masterExited = false;
		try {
			const r = spawnSync("ssh", ["-o", `ControlPath=${c.socket}`, "-O", "exit", "x"], {
				stdio: "ignore",
				timeout: 10_000,
			});
			masterExited = r.status === 0;
		} catch {
			/* master may still be running */
		}
		if (masterExited || !existsSync(c.socket)) {
			try {
				rmSync(c.socket);
			} catch {
				/* ok */
			}
		}
		this.connections.delete(key);
		// The comment above destroyConn call sites promises this: drop sudo
		// passwords cached for this connection in every session, so a stale
		// password never leaks across reconnect (or stays in memory forever).
		this.deleteSudoPasswords(key);
		for (let i = this.remoteTasks.length - 1; i >= 0; i--) {
			if (this.remoteTasks[i].host === c.alias || this.remoteTasks[i].host === c.key) {
				this.remoteTasks.splice(i, 1);
			}
		}
		this.saveRemoteTasks();
		this.emitNotify(`Closed ${c.key}.`, "info");
	}

	/** Discover live ControlMaster sockets from disk and prune dead in-memory connections. */
	async syncFromDisk(): Promise<void> {
		if (!existsSync(SOCKET_DIR)) return;
		try {
			const entries = readdirSync(SOCKET_DIR);
			const checks: Promise<void>[] = [];
			for (const name of entries) {
				if (!name.endsWith(".sock")) continue;
				const sock = join(SOCKET_DIR, name);
				checks.push(
					(async () => {
						try {
							const result = await spawnAsync("ssh", ["-O", "check", "-o", `ControlPath=${sock}`, "x"], {
								timeout: 5000,
							});
							const combined = result.stdout + result.stderr;
							if (result.status !== 0 && !/master running/i.test(combined)) {
								try {
									rmSync(sock);
								} catch {
									/* ok */
								}
								return;
							}
							const key = keyFromFilename(name);
							if (![...this.connections.values()].some((c) => c.socket === sock)) {
								const lastColon = key.lastIndexOf(":");
								if (lastColon < 0) return;
								const uh = key.substring(0, lastColon);
								const pt = key.substring(lastColon + 1);
								this.addConn(key, uh, sock, pt && pt !== "22" ? `-p ${pt} ${uh}` : uh);
							}
						} catch (syncErr: any) {
							if (syncErr.code === "ENOENT" || syncErr.code === "EACCES") return;
							try {
								rmSync(sock);
							} catch {
								/* ok */
							}
						}
					})(),
				);
			}
			await Promise.all(checks);
		} catch {
			/* empty */
		}
		// Prune stale in-memory connections
		const pruneChecks: Promise<void>[] = [];
		for (const [key, conn] of this.connections) {
			pruneChecks.push(
				(async () => {
					const sockExists = existsSync(conn.socket);
					if (!sockExists) {
						if (conn.proc) {
							try {
								conn.proc.kill();
							} catch {
								/* ok */
							}
						}
						this.rejectPending(conn, "Connection pruned (socket missing)");
						this.connections.delete(key);
						this.deleteSudoPasswords(key);
						return;
					}
					try {
						const result = await spawnAsync("ssh", ["-o", `ControlPath=${conn.socket}`, "-O", "check", "x"], {
							timeout: 2000,
						});
						const combined = result.stdout + result.stderr;
						if (result.status !== 0 && !/master running/i.test(combined)) {
							if (conn.proc) {
								try {
									conn.proc.kill();
								} catch {
									/* ok */
								}
							}
							this.rejectPending(conn, "Connection pruned (master dead)");
							try {
								rmSync(conn.socket);
							} catch {
								/* ok */
							}
							this.connections.delete(key);
							this.deleteSudoPasswords(key);
						}
					} catch {
						/* transient — leave the entry */
					}
				})(),
			);
		}
		await Promise.all(pruneChecks);
	}

	private rejectPending(conn: SshConnection, message: string): void {
		for (const [, p] of conn.pending) {
			if (p.timer) clearTimeout(p.timer);
			try {
				p.reject(new Error(message));
			} catch {
				/* ok */
			}
		}
		conn.pending.clear();
	}

	async findConnection(host: string): Promise<SshConnection | undefined> {
		await this.syncFromDisk();
		const s = host.toLowerCase();
		for (const [, c] of this.connections) {
			if (c.aliases.has(s) || c.key.toLowerCase() === s) return c;
		}
		const substringMatches: Array<[string, SshConnection]> = [];
		for (const [key, c] of this.connections) {
			if (c.key.toLowerCase().includes(s) || [...c.aliases].some((a) => a.includes(s))) {
				substringMatches.push([key, c]);
			}
		}
		if (substringMatches.length === 1) {
			return substringMatches[0][1];
		}
		return undefined;
	}

	/** Drop a connection whose master died. Returns true when the connection was stale. */
	async dropIfStale(conn: SshConnection): Promise<boolean> {
		if (await this.isConnected(conn.key)) return false;
		if (conn.proc) {
			try {
				conn.proc.kill();
			} catch {
				/* ok */
			}
		}
		this.connections.delete(conn.key);
		// Drop any sudo passwords cached for this connection in every session.
		this.deleteSudoPasswords(conn.key);
		try {
			rmSync(conn.socket);
		} catch {
			/* ok */
		}
		return true;
	}

	// ── persistent shell ──────────────────────────────────────────────────

	private ensureShell(conn: SshConnection): void {
		if (
			conn.proc &&
			conn.proc.exitCode === null &&
			conn.proc.signalCode === null &&
			!conn.proc.killed &&
			conn.proc.stdin &&
			!conn.proc.stdin.destroyed &&
			!conn.proc.stdin.writableEnded
		) {
			return;
		}

		if (conn.proc) {
			conn.proc.stdout?.removeAllListeners();
			conn.proc.stderr?.removeAllListeners();
			conn.proc.stdin?.removeAllListeners();
			conn.proc.removeAllListeners();
			try {
				conn.proc.kill();
			} catch {
				/* ok */
			}
			conn.proc = null;
		}
		for (const [, p] of conn.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error("Connection reset"));
		}
		conn.pending.clear();
		conn.buf = "";
		conn.reqId = 0;
		// New shell process — the sudo helper (variable + function) is gone.
		conn.sudoPrimed = false;

		const args = [
			"ssh",
			"-o",
			`ControlPath=${conn.socket}`,
			"-o",
			"ConnectTimeout=5",
			"-o",
			"LogLevel=ERROR",
			...conn.sshTarget.split(" "),
		];
		conn.proc = spawn(args[0], args.slice(1), { stdio: ["pipe", "pipe", "pipe"] });

		if (conn.proc.stdout) {
			conn.proc.stdout.on("data", (chunk: Buffer) => this.appendShellOutput(conn, chunk.toString()));
		}
		if (conn.proc.stderr) {
			conn.proc.stderr.on("data", (chunk: Buffer) => this.appendShellOutput(conn, chunk.toString()));
		}

		const onDead = (message: string) => {
			const deadProc = conn.proc;
			conn.proc = null;
			for (const [, p] of conn.pending) {
				if (p.timer) clearTimeout(p.timer);
				if (deadProc) {
					deadProc.removeListener("exit", p.onProcExit);
					deadProc.stdin?.removeListener("error", p.onStdinError);
					if (p.onDrain) deadProc.stdin?.removeListener("drain", p.onDrain);
				}
				p.reject(new Error(message));
			}
			conn.pending.clear();
		};
		conn.proc.on("exit", (code) => onDead(`SSH shell exited (code ${code})`));
		conn.proc.on("error", (err) => onDead(`SSH shell error: ${err.message}`));
	}

	/** Feed shell output into the response protocol (stdout/stderr data handler). */
	appendShellOutput(conn: SshConnection, data: string): void {
		conn.buf += data;
		this.extractResponses(conn);
	}

	private extractResponses(conn: SshConnection): void {
		const MAX_BUF = 2 * 1024 * 1024;
		if (conn.buf.length > MAX_BUF) {
			let truncatePos = -1;
			const markerRegex = /__END__(\d+)_(\w+):(\d+)\n/g;
			for (let match = markerRegex.exec(conn.buf); match !== null; match = markerRegex.exec(conn.buf)) {
				const reqId = parseInt(match[1], 10);
				const rand = match[2];
				const p = conn.pending.get(reqId);
				if (p && p.rand === rand) truncatePos = match.index;
			}
			if (truncatePos >= 0) {
				conn.buf = conn.buf.substring(truncatePos);
			} else {
				const keep = Math.floor(MAX_BUF / 2);
				const discardEnd = conn.buf.length - keep;
				const lastNewline = conn.buf.lastIndexOf("\n", discardEnd);
				const truncateFrom = lastNewline >= 0 ? lastNewline + 1 : discardEnd;
				conn.buf = conn.buf.substring(truncateFrom);
			}
		}
		for (;;) {
			const m = conn.buf.match(/__END__(\d+)_(\w+):(\d+)\n/);
			if (!m) break;
			const idx = conn.buf.indexOf(m[0]);
			const reqId = parseInt(m[1], 10);
			const rand = m[2];
			const p = conn.pending.get(reqId);
			if (p && p.rand === rand) {
				const startIdx = conn.buf.indexOf(p.bufAtWrite);
				const output =
					startIdx >= 0 ? conn.buf.substring(startIdx + p.bufAtWrite.length, idx) : conn.buf.substring(0, idx);
				conn.buf = conn.buf.substring(idx + m[0].length);
				conn.pending.delete(reqId);
				if (p.timer) clearTimeout(p.timer);
				if (conn.proc) {
					conn.proc.removeListener("exit", p.onProcExit);
					conn.proc.stdin?.removeListener("error", p.onStdinError);
					if (p.onDrain) conn.proc.stdin?.removeListener("drain", p.onDrain);
				}
				p.resolve(output);
			} else {
				// Orphaned/injected marker — remove only the marker text itself.
				conn.buf = conn.buf.substring(0, idx) + conn.buf.substring(idx + m[0].length);
			}
		}
	}

	// ── sudo support ────────────────────────────────────────────────────
	/** In-memory sudo passwords, keyed by "<sessionId>:<connectionKey>". Never persisted. */
	private readonly sudoPasswords = new Map<string, string>();

	/** Drop every sudo password for a connection (all sessions). */
	private deleteSudoPasswords(connKey: string): void {
		this.sudoPasswords.delete(connKey); // legacy unnamespaced entries
		for (const k of [...this.sudoPasswords.keys()]) {
			if (k.endsWith(`:${connKey}`)) this.sudoPasswords.delete(k);
		}
	}

	/** Drop every sudo password owned by a session (session shutdown). */
	deleteSessionSudoPasswords(sessionId: string): void {
		const prefix = `${sessionId}:`;
		for (const k of [...this.sudoPasswords.keys()]) {
			if (k.startsWith(prefix)) this.sudoPasswords.delete(k);
		}
	}

	/** Store a sudo password for a connection (memory only, never written to disk). */
	setSudoPassword(key: string, password: string): void {
		this.sudoPasswords.set(key, password);
		// Password changed — the remote shell's cached copy is stale.
		// Keys are "<sessionId>:<connKey>" (sudoPasswordKey); connections are
		// keyed by the bare connKey, so strip the per-session prefix.
		const connKey = key.slice(key.indexOf(":") + 1);
		const conn = this.connections.get(connKey);
		if (conn) conn.sudoPrimed = false;
	}

	hasSudoPassword(key: string): boolean {
		return this.sudoPasswords.has(key);
	}

	/**
	 * Inject the sudo helper into the connection's remote shell (once per
	 * shell): a shell variable holding the password plus a `sudo()` function
	 * that feeds it to `sudo -S`. Afterwards any plain `sudo cmd` just works
	 * — the password never appears in the command text, the process list, or
	 * the LLM-visible output.
	 *
	 * Passwords are keyed by session (see setSudoPassword); callers must
	 * pass the same passwordKey they stored with.
	 */
	async primeSudo(conn: SshConnection, force = false, passwordKey?: string): Promise<void> {
		if (conn.sudoPrimed && !force) return;
		const password = this.sudoPasswords.get(passwordKey ?? conn.key);
		if (password === undefined) throw new Error(`No sudo password stored for ${conn.alias}`);
		const escaped = password.replace(/'/g, "'\\''");
		await this.shellExec(
			conn,
			`umask 077; __PI_SUDOPW_DIR=$(mktemp -d) && ` +
				`printf '%s' '${escaped}' > "$__PI_SUDOPW_DIR/pw" && ` +
				`printf '#!/bin/sh\\ncat "%s"\\n' "$__PI_SUDOPW_DIR/pw" > "$__PI_SUDOPW_DIR/askpass" && ` +
				`chmod 700 "$__PI_SUDOPW_DIR/askpass" && ` +
				`sudo() { SUDO_ASKPASS="$__PI_SUDOPW_DIR/askpass" command sudo -A "$@"; }; ` +
				// Export so `nohup bash -c '...'` children (the foreground/background
				// command path) inherit the helper — a plain `sudo` there would fail
				// with "a terminal is required". The password itself is NEVER exported:
				// it lives in a 0600 file behind the askpass helper, so it cannot leak
				// through `env` or /proc/*/environ into model-visible output. The
				// `__PI_SUDOPW` name prefix keeps these lines covered by sanitizeOutput.
				`export -f sudo; export __PI_SUDOPW_DIR`,
			15_000,
		);
		conn.sudoPrimed = true;
	}

	shellExec(conn: SshConnection, cmd: string, timeout: number): Promise<string> {
		return new Promise((resolve, reject) => {
			this.ensureShell(conn);
			if (
				!conn.proc ||
				conn.proc.exitCode !== null ||
				conn.proc.signalCode !== null ||
				!conn.proc.stdin ||
				conn.proc.stdin.destroyed ||
				conn.proc.stdin.writableEnded
			) {
				reject(new Error("SSH shell not available"));
				return;
			}
			const reqId = ++conn.reqId;
			const rand = Math.random().toString(36).slice(2, 10);
			let settled = false;
			const done = (fn: () => void) => {
				if (!settled) {
					settled = true;
					fn();
				}
			};
			const cleanupListeners = () => {
				if (conn.proc) {
					conn.proc.removeListener("exit", onProcExit);
					conn.proc.stdin?.removeListener("error", onStdinError);
					if (onDrain) conn.proc.stdin?.removeListener("drain", onDrain);
				}
			};

			const timer = setTimeout(() => {
				done(() => {
					cleanupListeners();
					if (conn.pending.has(reqId)) {
						const entry = conn.pending.get(reqId)!;
						conn.pending.delete(reqId);
						if (entry.timer) clearTimeout(entry.timer);
						// Sanitize: the buffer may still hold the sudo-prime command
						// line (with the plaintext password) if that very command timed
						// out — never let it into an error message that reaches the model.
						const partial = sanitizeSudoPrime(conn.buf || entry.bufAtWrite).substring(0, 1000);
						entry.reject(new Error(`SSH command timeout after ${timeout / 1000}s. Partial output: ${partial}`));
					}
				});
			}, timeout);

			const onStdinError = (err: Error) => {
				done(() => {
					clearTimeout(timer);
					cleanupListeners();
					conn.pending.delete(reqId);
					reject(new Error(`SSH stdin error: ${err.message}`));
				});
			};

			const onProcExit = (code: number | null) => {
				done(() => {
					clearTimeout(timer);
					cleanupListeners();
					conn.pending.delete(reqId);
					reject(new Error(`SSH shell exited (code ${code}) unexpectedly`));
					if (onDrain) conn.proc?.stdin?.removeListener("drain", onDrain);
				});
			};
			conn.proc.once("exit", onProcExit);
			if (conn.proc.exitCode !== null || conn.proc.signalCode !== null) {
				onProcExit(conn.proc.exitCode);
				return;
			}

			conn.proc.stdin.once("error", onStdinError);

			const bufAtWrite = conn.buf;
			conn.pending.set(reqId, {
				resolve,
				reject,
				rand,
				timer,
				onProcExit,
				onStdinError,
				onDrain: undefined,
				bufAtWrite,
			});

			let onDrain: (() => void) | undefined;
			try {
				const wrote = conn.proc.stdin.write(`${cmd}\necho __END__${reqId}_${rand}:$?\n`);
				onDrain = () => {
					// Response arrives via extractResponses; done() prevents double-settle.
				};
				if (conn.pending.has(reqId)) conn.pending.get(reqId)!.onDrain = onDrain;
				if (!wrote) {
					conn.proc.stdin.once("drain", onDrain);
				}
			} catch (writeErr: any) {
				done(() => {
					clearTimeout(timer);
					cleanupListeners();
					conn.pending.delete(reqId);
					reject(new Error(`SSH write failed: ${writeErr.message}`));
				});
				if (onDrain) conn.proc?.stdin?.removeListener("drain", onDrain);
			}
		});
	}

	// ── remote background tasks ────────────────────────────────────────────

	/** Start a nohup-backgrounded command on the remote host (deduplicated). */
	async spawnRemoteBg(
		host: string,
		command: string,
		conn: SshConnection,
		sessionId?: string,
	): Promise<{ logPath: string; pid: string | null; deduplicated: boolean }> {
		const bgLockKey = `${host}\x00${command}`;
		const lockDeadline = Date.now() + 15_000;
		// A dedup hit must adopt the caller's session into the task's audience —
		// otherwise, if the original spawning session is gone, this session never
		// receives the completion it was told to expect.
		const adopt = (t: { sessionId?: string; sessionIds?: string[] }) => {
			if (!sessionId) return;
			const ids = t.sessionIds ?? (t.sessionId ? [t.sessionId] : []);
			if (!ids.includes(sessionId)) {
				ids.push(sessionId);
				t.sessionIds = ids;
				this.saveRemoteTasks();
			}
		};
		while (this.spawningRemoteBg.has(bgLockKey)) {
			const existing = this.remoteTasks.find((t) => t.host === host && t.cmd === command);
			if (existing) {
				adopt(existing);
				return { logPath: existing.logPath, pid: existing.pid, deduplicated: true };
			}
			if (Date.now() > lockDeadline) {
				this.spawningRemoteBg.delete(bgLockKey);
				break;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		this.spawningRemoteBg.add(bgLockKey);
		try {
			const existingAfterLock = this.remoteTasks.find((t) => t.host === host && t.cmd === command);
			if (existingAfterLock) {
				adopt(existingAfterLock);
				return { logPath: existingAfterLock.logPath, pid: existingAfterLock.pid, deduplicated: true };
			}

			const logPath = `/tmp/pi-bg-${Date.now().toString(36)}.log`;
			this.remoteTasks.push({ host, logPath, cmd: command, pid: null, startTime: Date.now(), sessionId });
			this.saveRemoteTasks();

			try {
				const bgCmd = `nohup bash -c '${command.replace(/'/g, "'\\''")}' > ${logPath} 2>&1 & echo PID=$!`;
				const result = await this.shellExec(conn, bgCmd, 15_000);
				conn.lastUse = Date.now();

				let pidMatch: RegExpExecArray | null = null;
				const pidRe = /PID=(\d+)/g;
				for (let match = pidRe.exec(result); match !== null; match = pidRe.exec(result)) {
					pidMatch = match;
				}
				const pid = pidMatch ? pidMatch[1] : null;

				this.pollRemoteTask(logPath, command, host, pid);
				return { logPath, pid, deduplicated: false };
			} catch (spawnErr) {
				const idx = this.remoteTasks.findIndex((t) => t.logPath === logPath);
				if (idx >= 0) {
					this.remoteTasks.splice(idx, 1);
					this.saveRemoteTasks();
				}
				throw spawnErr;
			}
		} finally {
			this.spawningRemoteBg.delete(bgLockKey);
		}
	}

	/**
	 * Register an already-running remote process (started by the foreground
	 * ssh_exec path) with the background-task poller, so its completion
	 * produces the usual notification. Does not restart the command.
	 */
	async monitorRunningRemoteTask(
		host: string,
		conn: SshConnection,
		command: string,
		logPath: string,
		pid: string,
		sessionId?: string,
	): Promise<void> {
		const existing = this.remoteTasks.find((t) => t.logPath === logPath);
		if (existing) {
			return;
		}
		this.remoteTasks.push({ host, logPath, cmd: command, pid, startTime: Date.now(), sessionId });
		this.saveRemoteTasks();
		this.pollRemoteTask(logPath, command, host, pid);
		conn.lastUse = Date.now();
	}

	/**
	 * Start a remote command under nohup and return immediately with its pid
	 * and log path. The command output (plus a __PI_EXIT__ marker line) is
	 * written to the log.
	 */
	async startRemoteNohup(conn: SshConnection, command: string): Promise<{ logPath: string; pid: string | null }> {
		const logPath = `/tmp/pi-fg-${Date.now().toString(36)}.log`;
		const escaped = command.replace(/'/g, `'\\''`);
		const wrapped = `nohup bash -c '${escaped}; echo "__PI_EXIT__$?"' > '${logPath}' 2>&1 & echo PID=$!`;
		const result = await this.shellExec(conn, wrapped, 20_000);
		conn.lastUse = Date.now();
		let pid: string | null = null;
		const pidRe = /PID=(\d+)/g;
		for (let match = pidRe.exec(result); match !== null; match = pidRe.exec(result)) {
			pid = match[1];
		}
		return { logPath, pid };
	}

	/**
	 * Check whether a remote pid is still alive, and read the log once it
	 * has finished (stripping the __PI_EXIT__ marker line).
	 */
	async waitRemoteProcess(
		conn: SshConnection,
		pid: string,
		logPath: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ finished: boolean; output?: string }> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (signal?.aborted) {
				return { finished: false };
			}
			const alive = await this.shellExec(conn, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`, 10_000);
			conn.lastUse = Date.now();
			if (!alive.includes("alive")) {
				const output = await this.shellExec(conn, `cat '${logPath}' 2>/dev/null`, 15_000);
				conn.lastUse = Date.now();
				return { finished: true, output: output.replace(/^__PI_EXIT__\d+\s*$/m, "") };
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
		return { finished: false };
	}

	private pollRemoteTask(logPath: string, cmd: string, host: string, pid: string | null): void {
		if (this.pollRemoteActive.has(logPath)) return;
		this.pollRemoteActive.add(logPath);
		const existing = this.remoteTasks.find((t) => t.logPath === logPath);
		if (!existing) {
			this.remoteTasks.push({ host, logPath, cmd, pid, startTime: Date.now() });
			this.saveRemoteTasks();
		}

		// Capture the owning session for targeted completion notification.
		const taskSessionId = this.remoteTasks.find((t) => t.logPath === logPath)?.sessionId;
		const taskSessionIds =
			this.remoteTasks.find((t) => t.logPath === logPath)?.sessionIds ??
			(taskSessionId ? [taskSessionId] : undefined);

		let lastSize = 0;
		let unchanged = 0;
		let errors = 0;
		const MAX_ERRORS = 5;
		let stopped = false;
		const MAX_POLLS = 720; // ≈ 60 min
		let pollCount = 0;

		const cleanup = () => {
			if (!stopped) {
				stopped = true;
				this.emitStatus("ssh-bg", undefined);
			}
			const idx = this.remoteTasks.findIndex((t) => t.logPath === logPath);
			if (idx >= 0) {
				this.remoteTasks.splice(idx, 1);
				this.saveRemoteTasks();
			}
			this.pollRemoteActive.delete(logPath);
		};

		const declareDone = async (c: SshConnection) => {
			if (stopped) return;
			stopped = true;
			this.emitStatus("ssh-bg", undefined);
			this.pollRemoteActive.delete(logPath);
			const idx = this.remoteTasks.findIndex((t) => t.logPath === logPath);
			if (idx >= 0) {
				this.remoteTasks.splice(idx, 1);
				this.saveRemoteTasks();
			}
			if (!(await this.isConnected(c.key))) {
				this.emitRemoteTaskMessage(
					[
						`[SSH background task completed on ${host} but connection lost]`,
						`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
						`Log on remote: ${logPath}`,
					],
					taskSessionIds,
				);
				return;
			}
			c.lastUse = Date.now();
			try {
				const output = await this.shellExec(c, `cat '${logPath}' 2>/dev/null`, 15_000);
				this.emitRemoteTaskMessage(
					[
						`[SSH background task completed on ${host}]`,
						`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
						`Output:\n${output.substring(0, 4000)}`,
						``,
						`Check the outputs and keep going — continue with the next step of the work; only report back to the user once everything is done.`,
					],
					taskSessionIds,
				);
			} catch {
				this.emitRemoteTaskMessage(
					[
						`[SSH background task completed on ${host} but output could not be retrieved]`,
						`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
						`The cat command failed when trying to read the log. Log on remote: ${logPath}`,
					],
					taskSessionIds,
				);
			}
		};

		const check = async () => {
			if (stopped) return;
			if (!this.pollRemoteActive.has(logPath)) {
				stopped = true;
				return;
			}
			pollCount++;
			if (pollCount > MAX_POLLS) {
				stopped = true;
				this.emitStatus("ssh-bg", undefined);
				const conn = await this.findConnection(host);
				const doCleanup = () => {
					this.pollRemoteActive.delete(logPath);
					const idx = this.remoteTasks.findIndex((t) => t.logPath === logPath);
					if (idx >= 0) {
						this.remoteTasks.splice(idx, 1);
						this.saveRemoteTasks();
					}
				};
				if (conn && (await this.isConnected(conn.key, true))) {
					conn.lastUse = Date.now();
					try {
						const output = await this.shellExec(
							conn,
							`cat '${logPath}' 2>/dev/null || echo '(unavailable)'`,
							15_000,
						);
						doCleanup();
						this.emitRemoteTaskMessage(
							[
								`[SSH background task on ${host} reached max polling duration (12 h)]`,
								`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
								`Output:\n${output.substring(0, 4000)}`,
							],
							taskSessionIds,
						);
					} catch {
						doCleanup();
						this.emitRemoteTaskMessage(
							[
								`[SSH background task on ${host} reached max polling duration (12 h)]`,
								`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
								`Log on remote: ${logPath}`,
							],
							taskSessionIds,
						);
					}
				} else {
					doCleanup();
					this.emitRemoteTaskMessage(
						[
							`[SSH background task on ${host} reached max polling duration (12 h), connection lost]`,
							`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
							`Log on remote: ${logPath}`,
						],
						taskSessionIds,
					);
				}
				return;
			}
			const conn = await this.findConnection(host);
			if (!conn || !(await this.isConnected(conn.key, true))) {
				this.emitRemoteTaskMessage(
					[
						`[SSH background task on ${host} lost connection]`,
						`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
						`Log on remote: ${logPath}`,
					],
					taskSessionIds,
				);
				cleanup();
				return;
			}
			conn.lastUse = Date.now();
			try {
				const result = await this.shellExec(conn, `wc -c < '${logPath}' 2>/dev/null || echo 0`, 10_000);
				if (stopped) return;
				const size = parseInt(result.trim(), 10) || 0;
				if (size === lastSize) {
					unchanged++;
					// No pid captured: liveness is inferred from log growth alone, so
					// use a much longer quiet window (~5 min) before declaring done —
					// a legitimately quiet command must not be finished early.
					const quietThreshold = pid ? 5 : 60;
					if (unchanged >= quietThreshold) {
						const pidCheck = pid ? `kill -0 ${pid} 2>/dev/null && echo alive || echo dead` : "echo unknown";
						conn.lastUse = Date.now();
						try {
							const pidResult = await this.shellExec(conn, pidCheck, 8_000);
							if (stopped) return;
							if (pidResult.trim() === "alive") {
								unchanged = 0;
								this.emitStatus("ssh-bg", `◐ SSH bg task running on ${host} (quiet)`);
								setTimeout(() => void check(), 5000);
							} else {
								await declareDone(conn);
							}
						} catch {
							await declareDone(conn);
						}
						return;
					}
				} else {
					lastSize = size;
					unchanged = 0;
					this.emitStatus("ssh-bg", `◐ SSH bg task running on ${host}`);
				}
				setTimeout(() => void check(), 5000);
			} catch {
				errors++;
				if (errors < MAX_ERRORS && !stopped) {
					setTimeout(() => void check(), 5000);
				} else {
					if (!stopped) {
						stopped = true;
						this.emitRemoteTaskMessage(
							[
								`[SSH background task polling failed on ${host}]`,
								`Command: ${(cmd || "(not persisted)").substring(0, 200)}`,
								`Log on remote: ${logPath}`,
							],
							taskSessionIds,
						);
					}
					cleanup();
				}
			}
		};
		setTimeout(() => void check(), 3000);
	}

	/** session_start: recover remote task polling across restarts. */
	async recoverRemoteTasks(): Promise<void> {
		await this.syncFromDisk();
		this.loadRemoteTasks();
		const now = Date.now();
		const toRemove = new Set<string>();
		for (const t of this.remoteTasks) {
			if (now - t.startTime > MAX_REMOTE_TASK_AGE_MS) {
				toRemove.add(t.logPath);
				continue;
			}
			const conn = await this.findConnection(t.host);
			if (conn && (await this.isConnected(conn.key))) {
				this.pollRemoteTask(t.logPath, t.cmd, t.host, t.pid);
			} else {
				toRemove.add(t.logPath);
			}
		}
		if (toRemove.size > 0) {
			for (let i = this.remoteTasks.length - 1; i >= 0; i--) {
				if (toRemove.has(this.remoteTasks[i].logPath)) this.remoteTasks.splice(i, 1);
			}
			if (this.remoteTasks.length === 0) {
				this.emitStatus("ssh-bg", undefined);
			}
		}
		this.saveRemoteTasks();
	}

	/** /ssh status lines. */
	async statusLines(): Promise<string[]> {
		if (this.connections.size === 0) return [];
		return Promise.all(
			[...this.connections.entries()].map(async ([k, c]) => `│ ${(await this.isConnected(c.key)) ? "●" : "○"} ${k}`),
		);
	}
}

function keyFromFilename(name: string): string {
	const raw = name.replace(/\.sock$/, "");
	if (raw.includes("@") && raw.includes(":")) return raw;
	const i1 = raw.indexOf("_");
	const i2 = raw.lastIndexOf("_");
	if (i1 < 0 || i2 <= i1) return raw;
	return `${raw.substring(0, i1)}@${raw.substring(i1 + 1, i2)}:${raw.substring(i2 + 1)}`;
}

// ── singleton ───────────────────────────────────────────────────────────────

let instance: SshConnectionStore | undefined;

export function getSshConnectionStore(): SshConnectionStore {
	if (!instance) {
		instance = new SshConnectionStore();
	}
	return instance;
}
