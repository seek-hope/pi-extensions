/**
 * Bash Gate — blocks bash commands that overlap with pi's specialized tools.
 *
 * When a model sends a bash command that duplicates functionality already
 * provided by a safer/more-structured pi tool (edit, write, ssh_exec,
 * bg_spawn, grep, find, ls), execution is blocked and the model receives a
 * pointer to the correct tool.
 *
 * Plain file-reading via cat/head/tail is intentionally NOT gated — the
 * model may inspect files through the shell freely; read() remains
 * available as an alternative, not a requirement. cat WRITE patterns
 * (heredoc `cat <<EOF`, `cat > file`, `cat ... >> file`) stay gated and
 * point at write()/edit().
 *
 * Shell-awareness:
 * - Commands are split into segments on unquoted `&&`, `||`, `;`, `|` and
 *   newline boundaries; each segment is checked independently (first matching
 *   segment wins), so `foo && ssh host cmd` cannot bypass `^`-anchored rules.
 * - Before matching, quoted/escaped content is normalized: quoted segments
 *   containing whitespace are masked (so `echo "don't > break"` never trips
 *   redirect rules and `grep 'cat <<EOF' src/` never trips heredoc rules),
 *   while quoted/escaped words without whitespace ('cat', "cat", \cat) are
 *   restored to their literal form so they cannot bypass the gate.
 *
 * Gate rules are defined declaratively; no runtime configuration needed.
 */
// ============================================================================
// Types
// ============================================================================

/**
 * Gate rule category. Read-like categories duplicate pi's file tools;
 * the remaining categories cover mutation, remote execution, background
 * execution, and polling patterns that have safer structured equivalents.
 */
export type BashGateCategory = "read" | "write" | "edit" | "remote" | "background" | "custom";

export interface BashGateRule {
	/** Human-readable name for debugging / logging. */
	name: string;
	/** Category of the blocked operation (see BashGateCategory). */
	category: BashGateCategory;
	/**
	 * Regular expression tested against the normalized command segment.
	 * Patterns carry the `m` (multiline) flag directly in the literal.
	 */
	pattern: RegExp;
	/** Which pi tool this rule maps to (for the hint message). */
	toolName: string;
	/** Why the command is blocked — included in the response. */
	reason: string;
	/**
	 * If true, the pattern is tested against the full normalized command
	 * instead of each individual segment. Used for loop/polling detection
	 * where the telltale pieces (e.g. `while` and `sleep`) are split across
	 * `;` segment boundaries.
	 */
	fullCommand?: boolean;
	/**
	 * If true, this rule is skipped when the segment contains an unquoted
	 * output redirect (`>` / `>>`) — e.g. `cat a b > c` is a write, not a
	 * read, and is handled by the redirect rules instead.
	 */
	skipIfRedirect?: boolean;
}

export interface BashGateMatch {
	rule: BashGateRule;
	/** The original (unnormalized) command segment that triggered the rule. */
	match: string;
}

// ============================================================================
// Shell normalization
// ============================================================================

/**
 * Split a command string on unquoted shell control operators:
 * `&&`, `||`, `;`, single `|`, and newlines. Quote state (`'...'`, `"..."`)
 * and backslash escapes are respected, so operators inside quotes do not
 * split. Redirections (`>`, `>>`, `<`, `2>`) are NOT split points.
 */
function splitShellCommand(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;
	let i = 0;

	while (i < command.length) {
		const c = command[i];

		if (quote) {
			current += c;
			if (c === quote) quote = null;
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			current += c;
			i++;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			current += c + command[i + 1];
			i += 2;
			continue;
		}
		if (c === "\n" || c === ";") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		if (c === "&" && command[i + 1] === "&") {
			segments.push(current);
			current = "";
			i += 2;
			continue;
		}
		// A single & is the background operator — it also starts a new
		// command, so `foo & cat /etc/passwd` must be two segments;
		// otherwise the `foo &` prefix defeats the ^-anchored read rules.
		if (c === "&") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		if (c === "|") {
			segments.push(current);
			current = "";
			i += command[i + 1] === "|" ? 2 : 1;
			continue;
		}

		current += c;
		i++;
	}

	segments.push(current);
	return segments;
}

/**
 * Normalize a command segment for rule matching:
 *
 * - Quoted content containing whitespace is replaced with a single space
 *   (masked), so gated patterns — redirects, heredocs, `sed -i`, etc. —
 *   never match inside quotes: `echo "don't > break"`, `grep 'cat <<EOF'`.
 * - A quoted word WITHOUT whitespace inside ('cat', "cat") is restored to
 *   its literal form, since quoting a bare word is a bypass attempt, not
 *   content.
 * - Backslash escapes at word start are unescaped (\cat -> cat); escapes
 *   elsewhere are masked.
 */
function normalizeSegment(segment: string): string {
	let out = "";
	let atWordStart = true;
	let i = 0;

	while (i < segment.length) {
		const c = segment[i];

		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			out += " ";
			atWordStart = true;
			i++;
			continue;
		}

		if (c === "'" || c === '"') {
			let end = i + 1;
			while (end < segment.length && segment[end] !== c) end++;
			const inner = segment.slice(i + 1, end);
			i = end < segment.length ? end + 1 : segment.length;
			out += inner.length > 0 && !/\s/.test(inner) ? inner : " ";
			atWordStart = false;
			continue;
		}

		// ANSI-C (`$'...'`) and locale (`$"..."`) quoting: decode the body like
		// the shell would, so `$'s'\''sh'` / `$"ssh"` cannot smuggle a gated
		// command past the rules.
		if (c === "$" && i + 1 < segment.length && (segment[i + 1] === "'" || segment[i + 1] === '"')) {
			const quote = segment[i + 1]!;
			let end = i + 2;
			while (end < segment.length && segment[end] !== quote) end++;
			let inner = segment.slice(i + 2, end);
			i = end < segment.length ? end + 1 : segment.length;
			if (quote === "'") {
				inner = inner.replace(/\\(x[0-9a-fA-F]{2}|0[0-7]{0,3}|u[0-9a-fA-F]{4}|.)/g, (_m, esc: string) => {
					if (esc[0] === "x" || esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
					if (esc[0] === "0") return String.fromCharCode(parseInt(esc.slice(1) || "0", 8));
					const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
					return simple[esc] ?? esc;
				});
			}
			out += inner.length > 0 && !/\s/.test(inner) ? inner : " ";
			atWordStart = false;
			continue;
		}

		if (c === "\\" && i + 1 < segment.length) {
			out += atWordStart ? segment[i + 1] : " ";
			atWordStart = false;
			i += 2;
			continue;
		}

		out += c;
		atWordStart = false;
		i++;
	}

	return out;
}

/** Matches an unquoted output redirect (`>` or `>>`) — not `2>`, `>&2`, `2>&1`. */
const OUTPUT_REDIRECT_RE = /(?<![\d>])>(?![&])/;

// ============================================================================
// Rule definitions
// ============================================================================

/** Wrapper + absolute-path prefix shared by the anchored rules.
 * Layers repeat: bare assignments (`FOO=1`), keyword wrappers (`sudo`,
 * `command`, `builtin`, `exec`, `nohup`, `setsid`, `nice`, `time`, `env`,
 * `stdbuf`, `timeout`, `xargs`) with their option/duration arguments, and an
 * optional absolute path are all stripped before the gated command word.
 * Residual: options with non-option operands (`sudo -u root`, `nice -n 5`)
 * stop the strip — documented limitation. */
const WRAPPER_PREFIX = String.raw`^(?:(?:\w+=\S+|sudo|command|builtin|exec|nohup|setsid|nice|time|env|stdbuf|timeout|xargs)(?:\s+-\S+|\s+\w+=\S+|\s+\d+\S*)*\s+)*(?:\/(?:usr\/)?(?:local\/)?bin\/)?`;

/**
 * All gate rules. Order matters: earlier rules take priority.
 *
 * Write/redirect rules come BEFORE read rules so that `cat a b > c` is
 * reported as a write (redirect), not a read. All write rules are anchored
 * to the segment start — mid-segment matching false-positives on commands
 * like `gcc -o printf main.c > log`.
 *
 * Coverage is intentionally pragmatic, not absolute. Known residual holes
 * (by design): interpreters running arbitrary code (`python -c ...`),
 * sed/awk scripts containing whitespace followed by a file operand (the
 * masked script makes the operand count ambiguous with stdin filters),
 * `eval`-based indirection, `tee` (primarily a logging pattern), and hex
 * viewers (od/xxd — read() is not a substitute).
 */
const GATE_RULES: BashGateRule[] = [
	// ── file writing / redirection (before reads!) ────────────────────
	{
		name: "heredoc-write",
		category: "write",
		pattern: new RegExp(WRAPPER_PREFIX + String.raw`cat\s*<<\s*['"]?(\w+)['"]?`, "m"),
		toolName: "write",
		reason: `Heredoc ("cat <<EOF") duplicates pi's write() tool. Use write({path, content}) — it avoids EOF delimiter mistakes and auto-creates directories.`,
	},
	{
		name: "append-redirect",
		category: "write",
		// Excludes fd appends (2>>err) and /dev/null sinks.
		pattern: new RegExp(WRAPPER_PREFIX + String.raw`(?:cat|echo|printf)\s+.*(?<!\d)>>\s*(?!\/dev\/null)(\S+)`, "m"),
		toolName: "edit",
		reason: `Append redirection (">>") duplicates pi's edit() tool. Use edit() for targeted modifications instead.`,
	},
	{
		name: "cat-redirect-write",
		category: "write",
		// Excludes fd redirects (2>err, >&2, 2>&1) and /dev/null sinks.
		pattern: new RegExp(WRAPPER_PREFIX + String.raw`cat\s+.*(?<![\d>])>(?![>&])\s*(?!\/dev\/null)(\S+)`, "m"),
		toolName: "write",
		reason: `File redirection (">") duplicates pi's write() tool. Use write({path, content}) instead — it auto-creates parent directories and avoids shell escaping issues.`,
	},
	{
		name: "echo-redirect-write",
		category: "write",
		pattern: new RegExp(
			WRAPPER_PREFIX + String.raw`(?:echo|printf)\s+.*(?<![\d>])>(?![>&])\s*(?!\/dev\/null)(\S+)`,
			"m",
		),
		toolName: "write",
		reason: `File redirection with echo/printf duplicates pi's write() tool. Use write() instead.`,
	},

	// ── file editing ──────────────────────────────────────────────────
	{
		name: "sed-in-place",
		category: "edit",
		// Covers -i, -i<SUFFIX> (GNU: -i.bak), macOS -i '' (masked to space
		// by normalization), and --in-place[=SUFFIX].
		pattern: /sed\s+(?:-[A-Za-z]*i(?:\.[^\s'"]+)?[A-Za-z]*|--in-place(?:=\S+)?)\s/m,
		toolName: "edit",
		reason: `"sed -i" duplicates pi's edit() tool. pi's edit() uses exact string matching (not regex), eliminating regex-escaping bugs. Use edit({path, oldText, newText}) instead.`,
	},
	{
		name: "awk-in-place",
		category: "edit",
		pattern: /awk\s+.*\s*>\s*\S+/m,
		toolName: "edit",
		reason: `awk with output redirection duplicates pi's edit() tool. Use edit() instead for reliable in-place edits.`,
	},
	{
		name: "perl-in-place",
		category: "edit",
		pattern: new RegExp(WRAPPER_PREFIX + String.raw`perl\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*i[A-Za-z]*(?:\s|$)`, "m"),
		toolName: "edit",
		reason: `"perl -pi -e" duplicates pi's edit() tool. Use edit() for reliable in-place edits.`,
	},

	// ── log following (before the plain read rules) ───────────────────
	{
		name: "tail-follow",
		category: "background",
		pattern: new RegExp(
			WRAPPER_PREFIX +
				String.raw`(?:tail\s+(?:(?:-[A-Za-z0-9]+|\d+)\s+)*(?:-[A-Za-z]*[fF][A-Za-z]*|--follow)(?:\s|$)|less\s+(?:-[A-Za-z]+\s+)*\+F)`,
			"m",
		),
		toolName: "bg_spawn",
		reason: `"tail -f" / "less +F" follows a growing file — read({offset: -N}) only takes a static snapshot and cannot follow a log. Use bg_spawn() to run the watcher in the background and get notified on completion or match.`,
	},

	// ── file reading ──────────────────────────────────────────────────
	// A read rule only fires when the command actually reads a FILE:
	// flags are consumed first, then a real (non-flag) operand or an
	// input redirect is required. `cmd | less`, `cmd | sed 's/a/b/'`
	// (stdin filters, no file operand) are legitimate and stay allowed.
	// Plain cat/head/tail file reads are intentionally NOT gated — the
	// model may inspect files through the shell freely; read() remains
	// available but is no longer forced.
	{
		name: "less-file",
		category: "read",
		pattern: new RegExp(
			WRAPPER_PREFIX + String.raw`(?:less|more|most)(?:\s+-[A-Za-z]+)*(?:\s+(?![><+-])\S|\s*<(?![<(])\s*\S)`,
			"m",
		),
		toolName: "read",
		reason: `"less/more <file>" duplicates pi's read() tool. Use read() instead — it provides the full file content.`,
		skipIfRedirect: true,
	},
	{
		// Nested shell invocation at segment start (bash -c, sh -c, bash -s,
		// zsh/dash variants): pure evasion — the bash tool already runs the
		// whole command in a shell, so write the inner command directly.
		// `bash script.sh` stays allowed; so do non-initial positions
		// (docker exec c bash -c ...).
		name: "nested-shell",
		category: "custom",
		pattern: new RegExp(WRAPPER_PREFIX + String.raw`(?:ba|z|da)?sh\s+(?:-[A-Za-z]*c\b|-s\b)`, "m"),
		toolName: "bash",
		reason: `Nested shell invocation ("bash -c", "sh -c", "bash -s") hides commands from the gate. The bash tool already runs your command in a shell — run the inner command directly instead.`,
	},
	{
		// sed/awk/perl used as a READER (not a filter): the telltale is a
		// script operand followed by a file operand (or script + input
		// redirect). `cmd | sed 's/a/b/'` stays allowed — after segment
		// splitting, a filter shows only the script operand.
		name: "sed-awk-read",
		category: "read",
		pattern: new RegExp(
			WRAPPER_PREFIX +
				String.raw`(?:sed|awk|perl)(?:\s+-\S+)*(?:\s+(?![><-])\S+(?:\s+(?![><-])\S+)+|\s+\S+\s*<(?![<(])\s*\S)`,
			"m",
		),
		toolName: "read",
		reason: `"sed/awk/perl <script> <file>" reads a file without transforming the pipeline — that duplicates pi's read() tool. Use read({path, offset, limit}) instead.`,
		skipIfRedirect: true,
	},

	// ── ssh / scp ─────────────────────────────────────────────────────
	{
		name: "ssh-remote",
		category: "remote",
		pattern: new RegExp(
			WRAPPER_PREFIX + String.raw`ssh\s+(?!(?:-T\s+)?git@)(?:-[A-Za-z0-9]+\s+)*(\S+@\S+|\S+)\s`,
			"m",
		),
		toolName: "ssh_exec",
		reason: `"ssh <host> <cmd>" duplicates pi's ssh_exec() tool. ssh_exec reuses persistent ControlMaster connections (faster, no re-auth), supports background execution via nohup, and provides scp_to_remote / scp_from_remote.`,
	},
	{
		name: "scp-transfer",
		category: "remote",
		pattern: new RegExp(WRAPPER_PREFIX + String.raw`scp\s`, "m"),
		toolName: "scp_to_remote",
		reason: `"scp" duplicates pi's scp_to_remote() / scp_from_remote() tools. These reuse the persistent SSH connection — no password prompts, and connection state is managed for you.`,
	},

	// ── background execution ──────────────────────────────────────────
	{
		name: "tmux-background",
		category: "background",
		pattern: /tmux\s+new(?:-session)?\s/m,
		toolName: "bg_spawn",
		reason: `"tmux new-session" duplicates pi's bg_spawn() tool. bg_spawn manages tmux sessions automatically, provides bg_status() for monitoring, and recovers tasks across pi session restarts. Use bg_spawn({task, timeoutMs}) instead.`,
	},
	{
		name: "nohup-background",
		category: "background",
		pattern: /nohup\s/m,
		toolName: "bg_spawn",
		reason: `"nohup" duplicates pi's bg_spawn() tool. bg_spawn handles output logging, status tracking, and cross-session recovery automatically.`,
	},

	// ── polling / sleep ──────────────────────────────────────────────
	{
		name: "sleep-command",
		category: "background",
		pattern: new RegExp(WRAPPER_PREFIX + String.raw`sleep\s+\d`, "m"),
		toolName: "bg_spawn",
		reason: `"sleep N" blocks the foreground. Pure sleeps are converted to the wait tool automatically; sleeps inside longer commands run as background tasks via bg_spawn. This command could not be converted automatically.`,
	},
	{
		name: "while-poll-loop",
		category: "background",
		// Tested against the full normalized command because `;` splitting
		// separates the loop header from the sleep. Blocks `while true`,
		// `while :`, and while/until loops containing `sleep N` — but NOT
		// `while read` line-iteration loops.
		pattern: /\b(?:while|until)\s+(?!read\b)(?:(?:true|:)(?!\w)|[\s\S]*?\bsleep\s+\d)/m,
		toolName: "bg_spawn",
		reason: `Polling loops (while/until ... sleep) are inefficient in the foreground. Use bg_spawn() to run the watcher in the background and get notified on completion.`,
		fullCommand: true,
	},
	{
		name: "watch-command",
		category: "background",
		pattern: /^\s*(?:\/(?:usr\/)?(?:local\/)?bin\/)?watch\s/m,
		toolName: "bg_spawn",
		reason: `"watch" is a polling tool. Use bg_spawn() to run the check in the background and get notified on completion.`,
	},
];

// ============================================================================
// Gate engine
// ============================================================================

/**
 * Test a bash command against the gate rules.
 * Returns the first matching rule, or undefined if the command is allowed.
 *
 * The command is split into segments on unquoted shell operators; each
 * segment is normalized (quoted content masked / command word unquoted) and
 * checked against every rule in priority order. The first matching segment
 * wins. The returned `match` is the original (unnormalized) segment text.
 */
export function checkBashGate(command: string): BashGateMatch | undefined {
	const rawSegments = splitShellCommand(command);
	const normalizedFull = normalizeSegment(command);

	for (const rawSegment of rawSegments) {
		const segment = normalizeSegment(rawSegment).trim();
		if (!segment) continue;
		const hasOutputRedirect = OUTPUT_REDIRECT_RE.test(segment);

		for (const rule of GATE_RULES) {
			if (rule.skipIfRedirect && hasOutputRedirect) continue;
			const target = rule.fullCommand ? normalizedFull : segment;
			const match = rule.pattern.exec(target);
			if (match) {
				return { rule, match: rule.fullCommand ? match[0] : rawSegment.trim() };
			}
		}
	}

	return undefined;
}

/**
 * Format a blocked-command response for the model.
 */
export function formatGateResponse(match: BashGateMatch): string {
	const { rule, match: commandMatch } = match;
	const truncated = commandMatch.length > 120 ? `${commandMatch.substring(0, 117)}...` : commandMatch;

	return [
		`[BLOCKED] The command \`${truncated}\` was not executed.`,
		``,
		`${rule.reason}`,
		``,
		`If you are waiting for a long-running task, use bg_spawn() to run it in the background.`,
	].join("\n");
}

// ============================================================================
// Automatic sleep conversion
// ============================================================================

/**
 * Parse a pure `sleep` command (after stripping optional prefixes such as
 * `sudo`, `env FOO=bar`, `nice`, or `/usr/bin/` paths) into total seconds.
 * Supports GNU sleep semantics: multiple time arguments are summed, each
 * accepts fractional values and an optional s/m/h/d suffix (`sleep 1m 30s`,
 * `sleep 0.5`, `sleep 1.5h`). Returns undefined when the duration cannot be
 * determined statically (variables, command substitution, arithmetic).
 */
export function parseSleepCommand(
	command: string,
): { kind: "pure"; seconds: number } | { kind: "mixed" } | { kind: "unparseable" } {
	const trimmed = command.trim();
	const rest = trimmed.replace(
		/^(?:(?:sudo|command|env(?:\s+\w+=\S+)*|xargs|nice|time|exec)\s+)*(?:\/(?:usr\/)?(?:local\/)?bin\/)?/,
		"",
	);
	const pureMatch = /^sleep\s+([0-9.]+[smhd]?(?:\s+[0-9.]+[smhd]?)*)\s*;?\s*$/.exec(rest);
	if (!pureMatch) {
		// A sleep at the start followed by other commands is a mixed command:
		// it can run as one background task. A non-sleep command is not ours.
		return /^sleep\b/.test(rest) ? { kind: "mixed" } : { kind: "unparseable" };
	}
	let seconds = 0;
	for (const arg of pureMatch[1].split(/\s+/)) {
		const timeMatch = /^(\d*\.?\d+)([smhd]?)$/.exec(arg);
		if (!timeMatch) return { kind: "unparseable" };
		const factor = timeMatch[2] === "d" ? 86400 : timeMatch[2] === "h" ? 3600 : timeMatch[2] === "m" ? 60 : 1;
		seconds += Number(timeMatch[1]) * factor;
	}
	return { kind: "pure", seconds };
}

/**
 * Decide what the bash tool should do when a gate rule blocks a command.
 *
 * - sleep-command with a pure duration → the wait tool (suspend the turn).
 * - sleep-command with a mixed command, while/until polling loops, and watch
 *   → run the whole command as one background task.
 * - anything else (including unparseable sleep arguments) → the ordinary
 *   gate response (blocked, pointed at bg_spawn).
 */
export function classifyBashGateCommand(
	command: string,
	ruleName: string,
): { kind: "wait"; seconds: number } | { kind: "bg" } | { kind: "gate" } {
	if (ruleName === "sleep-command") {
		const parsed = parseSleepCommand(command);
		if (parsed.kind === "pure") return { kind: "wait", seconds: parsed.seconds };
		if (parsed.kind === "mixed") return { kind: "bg" };
		return { kind: "gate" };
	}
	if (ruleName === "while-poll-loop" || ruleName === "watch-command") {
		return { kind: "bg" };
	}
	return { kind: "gate" };
}
