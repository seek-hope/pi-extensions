/**
 * codegraph-scan (pi-ex): after an edit, run a read-only codegraph callers
 * scan over the changed identifiers and append the result to the edit
 * output. Migrated from pi-ex core's edit-tool wrapper.
 *
 * Best-effort: a missing/slow/failing scan never breaks the edit result.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getForkHost } from "@earendil-works/pi-coding-agent";
import { extractChangedIdentifiers, runPostEditScan } from "./lib/scan.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" || event.isError) return;
		const host = getForkHost(ctx.sessionManager);
		if (host && !host.settingsManager.getCodeScanEnabled()) return;
		const edits = (event.input as { edits?: Array<{ oldText?: string; newText?: string }> } | undefined)?.edits;
		if (!Array.isArray(edits) || edits.length === 0) return;
		const changed = extractChangedIdentifiers(edits);
		if (changed.length === 0) return;
		try {
			const scan = await runPostEditScan(changed, { cwd: ctx.cwd });
			if (!scan) return;
			return { content: [...(event.content ?? []), { type: "text" as const, text: scan }] };
		} catch {
			// never break the edit result
		}
	});
}
