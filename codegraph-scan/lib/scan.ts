/**
 * Post-edit scan — after a successful edit, surface what still needs
 * syncing by querying the codegraph CLI directly (read-only):
 *
 *   codegraph callers <identifier> — for each identifier the edit
 *   removed/changed, list the call sites that still reference the old name.
 *
 * There is deliberately no sync step: codegraph's daemon auto-syncs the
 * index on file changes, so consumers only read. The scan runs against
 * whatever index state the daemon has published; a slightly stale hint is
 * acceptable for a best-effort nudge.
 *
 * Best-effort by design: a missing binary, an uninitialized project, slow
 * runs (deadline — the child is killed) or errors all degrade silently.
 * The scan must never break or block the edit result beyond its budget.
 */

import { execFile } from "node:child_process";

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const MAX_IDENTIFIERS = 3;
const MIN_IDENTIFIER_LEN = 3;
const MAX_OUTPUT_PER_TOOL = 1500;
const MAX_TOTAL_OUTPUT = 6000;
const CODEGRAPH_BIN = "codegraph";

/** Prose/keyword noise that would flood a reference scan. */
const STOPWORDS = new Set([
	"the",
	"this",
	"that",
	"these",
	"those",
	"with",
	"from",
	"into",
	"onto",
	"over",
	"under",
	"function",
	"return",
	"const",
	"let",
	"var",
	"new",
	"class",
	"interface",
	"type",
	"import",
	"export",
	"true",
	"false",
	"null",
	"undefined",
	"async",
	"await",
	"string",
	"number",
	"boolean",
	"object",
	"void",
	"unknown",
	"any",
	"if",
	"else",
	"for",
	"while",
	"switch",
	"case",
	"break",
	"continue",
	"try",
	"catch",
	"finally",
	"throw",
	"extends",
	"implements",
	"public",
	"private",
	"protected",
	"static",
	"readonly",
	"enum",
	"namespace",
	"default",
	"typeof",
	"instanceof",
	"delete",
	"in",
	"of",
]);

/**
 * Extract up to MAX_IDENTIFIERS identifiers that the edit removed or
 * changed: present in oldText, absent from newText. Order-preserving,
 * deduplicated, stopword-filtered.
 */
export function extractChangedIdentifiers(edits: Array<{ oldText?: string; newText?: string }>): string[] {
	const found: string[] = [];
	const seen = new Set<string>();

	for (const edit of edits) {
		const oldText = edit.oldText ?? "";
		const newText = edit.newText ?? "";
		if (!oldText || oldText === newText) continue;
		const kept = new Set(newText.match(IDENTIFIER_RE) ?? []);
		for (const match of oldText.matchAll(IDENTIFIER_RE)) {
			const id = match[0];
			if (id.length < MIN_IDENTIFIER_LEN) continue;
			if (STOPWORDS.has(id)) continue;
			if (kept.has(id)) continue;
			if (seen.has(id)) continue;
			seen.add(id);
			found.push(id);
			if (found.length >= MAX_IDENTIFIERS) return found;
		}
	}
	return found;
}

export interface PostEditScanOptions {
	/** Project cwd — the codegraph index is per-project. */
	cwd: string;
	/** Total wall-clock budget for the whole scan (default 5s). */
	deadlineMs?: number;
}

/** codegraph prints this marker (exit 0) when a symbol is unknown. */
const NOT_FOUND_RE = /Symbol "[^"]*" not found/;

/** One `codegraph callers` call with a hard timeout (kills the child). All failures → undefined. */
function cliCallers(identifier: string, cwd: string, timeoutMs: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			CODEGRAPH_BIN,
			["callers", identifier],
			{ cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				if (error) return resolve(undefined);
				const text = (stdout ?? "").trim();
				if (!text || NOT_FOUND_RE.test(text)) return resolve(undefined);
				resolve(text);
			},
		);
	});
}

/**
 * Run the reference scan for the identifiers the edit changed. Returns a
 * text block to append to the edit result, or undefined when there is
 * nothing worth surfacing (or any degradation triggered).
 */
export async function runPostEditScan(changed: string[], options: PostEditScanOptions): Promise<string | undefined> {
	if (changed.length === 0) return undefined;
	const deadline = Date.now() + (options.deadlineMs ?? 5000);

	const sections: string[] = [];
	let total = 0;
	for (const identifier of changed) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const text = await cliCallers(identifier, options.cwd, remaining);
		if (!text) continue;
		const clipped = cap(text, MAX_OUTPUT_PER_TOOL);
		sections.push(`Still referencing \`${identifier}\`:\n${clipped}`);
		total += clipped.length;
		if (total >= MAX_TOTAL_OUTPUT) break;
	}
	if (sections.length === 0) return undefined;
	return cap(`[Post-edit scan — remaining references]\n${sections.join("\n\n")}`, MAX_TOTAL_OUTPUT + 100);
}

function cap(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… (truncated)`;
}
