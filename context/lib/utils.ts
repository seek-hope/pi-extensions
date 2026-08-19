/**
 * Fork-specific compaction helpers (pi-ex).
 *
 * These live outside utils.ts so that utils.ts can stay byte-identical to
 * upstream pi: upstream files are never edited by the fork, which keeps
 * `sync upstream` merges conflict-free. When upstream changes equivalent
 * functionality, reconcile here deliberately.
 */
import type { Message } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";

/**
 * Rough token estimate for a text string, CJK-aware.
 *
 * The naive chars/4 heuristic underestimates CJK text 2-4x: CJK codepoints
 * (and fullwidth forms) tokenize at roughly 1 token each, while other text
 * averages ~4 chars per token. Single pass over UTF-16 code units (all CJK
 * ranges below are in the BMP), no dependencies.
 */
export function estimateTextTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (
			(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
			(code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
			(code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
			(code >= 0xff00 && code <= 0xffef) // Fullwidth ASCII / halfwidth forms
		) {
			cjk++;
		} else {
			other++;
		}
	}
	return cjk + Math.ceil(other / 4);
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Full fidelity: user/assistant text, assistant thinking, tool calls with
 * full arguments, and tool results are all included untruncated. Oversized
 * requests are handled by dropping oldest rounds (see
 * generateSummaryWithUsage), not by lossy serialization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${content}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Balanced JSON extraction
// ============================================================================

/**
 * Extract the first balanced JSON span (object or array) from a model reply.
 * Unlike a first/last-brace slice or a lazy regex (truncated by nested or
 * in-string brackets), this scans forward from the first open bracket,
 * tracking depth while honoring quoted strings and escapes. Returns an empty
 * string when no balanced span is found.
 */
export function extractFirstBalancedJson(text: string, open: "{" | "[" = "{"): string {
	const close = open === "{" ? "}" : "]";
	const start = text.indexOf(open);
	if (start === -1) return "";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return "";
}
