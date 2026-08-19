/**
 * Post-compaction review — extracts uncertain items from the checkpoint
 * summary and lets the user (or the auto-review pass) confirm or dismiss
 * them before they become permanent context.
 */

/**
 * Marker written by dismissItems() directly after a dismissed entry line.
 * parseUncertainItems() skips entries carrying this marker.
 */
export const DISMISSED_MARKER = "[REVIEWED — dismissed by user]";

/** Marker for entries the auto-review pass verified against the conversation. */
export const AUTO_REVIEWED_MARKER = "[REVIEWED — auto-verified]";

/** Any review marker line (user or auto) makes the entry above it a non-item. */
export function isReviewMarker(line: string): boolean {
	return line.trim().startsWith("[REVIEWED —");
}

export interface UncertainItem {
	type: "inference" | "question" | "state";
	text: string;
	/** Line number in the original summary where this item appears. */
	sourceLine: number;
}

/**
 * Parse the checkpoint summary text to find sections containing
 * unverified items that should be reviewed by the user.
 */
export function parseUncertainItems(summary: string): UncertainItem[] {
	const items: UncertainItem[] = [];
	const lines = summary.split("\n");

	let section: "inference" | "question" | "state" | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.startsWith("### Model Inferences")) {
			section = "inference";
			continue;
		}
		if (line.startsWith("### Open Questions")) {
			section = "question";
			continue;
		}
		if (line.startsWith("### External State")) {
			section = "state";
			continue;
		}
		// End of section: next heading or blank line
		if (line.startsWith("### ") || line.startsWith("## ")) {
			section = null;
			continue;
		}

		if (section && line.trim().startsWith("- ")) {
			const text = line.replace(/^- /, "").trim();
			// Skip items the user dismissed in a previous review or the auto-
			// review pass already settled (markers are persisted in the
			// summary, so this survives restarts).
			const next = lines[i + 1]?.trim();
			if (text && !isReviewMarker(next ?? "")) {
				items.push({ type: section, text, sourceLine: i });
			}
		}
	}

	return items;
}

/**
 * Modify the summary text to mark specific lines as dismissed.
 * Returns the updated summary.
 */
export function dismissItems(summary: string, dismissedLines: Set<number>): string {
	if (dismissedLines.size === 0) return summary;

	const lines = summary.split("\n");
	const out: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]);
		if (dismissedLines.has(i)) {
			out.push(`  ${DISMISSED_MARKER}`);
		}
	}

	return out.join("\n");
}
