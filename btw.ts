/**
 * /btw command — ask a temporary question without affecting the current session.
 * Spawns a separate ephemeral pi invocation (print mode) so the side query and
 * its answer never touch the active session history.
 *
 * Results are shown in a scrollable overlay (↑↓/j/k/gg/G to scroll, esc/q to close).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, Key } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";

// ── scrollable result viewer ────────────────────────────────────────────────

class ScrollViewer {
  private lines: string[];
  private scroll = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(content: string) {
    // Split but keep empty lines
    this.lines = content.split("\n");
  }

  handleInput(data: string): boolean {
    const visible = this.visibleLines();
    if (matchesKey(data, Key.down) || data === "j") {
      if (this.scroll < this.lines.length - visible) { this.scroll++; this.invalidate(); }
      return true;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.scroll > 0) { this.scroll--; this.invalidate(); }
      return true;
    }
    if (data === "g") {
      if (this.scroll > 0) { this.scroll = 0; this.invalidate(); }
      return true;
    }
    if (matchesKey(data, Key.home) || data === "G") {
      const bottom = Math.max(0, this.lines.length - visible);
      if (this.scroll < bottom) { this.scroll = bottom; this.invalidate(); }
      return true;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      return false; // signal close
    }
    if (matchesKey(data, Key.enter)) {
      return false; // close on enter too
    }
    return true;
  }

  private visibleLines(): number {
    // Terminal height minus header/footer/borders (~6 lines overhead)
    const rows = process.stdout.rows || 24; return Math.max(5, rows - 8);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const out: string[] = [];
    const maxLineWidth = width - 2; // margin
    const visible = this.visibleLines();
    const end = Math.min(this.scroll + visible, this.lines.length);

    // Trim lines to fit width
    for (let i = this.scroll; i < end; i++) {
      const line = this.lines[i];
      if (line.length <= maxLineWidth) {
        out.push(" " + line);
      } else {
        out.push(" " + line.substring(0, maxLineWidth - 1) + "…");
      }
    }

    // Pad to visible height
    while (out.length < visible) {
      out.push("");
    }

    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── spawn pi in ephemeral print mode ────────────────────────────────────────

function runSideQuery(question: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      "pi",
      ["-p", "--no-context-files", "--no-session", question],
      {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(stderr.trim() || stdout.trim() || `(pi exited with code ${code})`);
      }
    });

    child.on("error", (err) => {
      resolve(`Failed to spawn side query: ${err.message}`);
    });

    setTimeout(() => {
      child.kill();
      if (!stdout.trim()) resolve("(side query timed out)");
    }, 120_000);
  });
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Ask a temporary question without affecting the current session",
    handler: async (args, ctx) => {
      const question = args?.trim();
      if (!question || question.length === 0) {
        ctx.ui.notify("Usage: /btw <your question>", "warning");
        return;
      }

      const statusId = "btw-" + Date.now();
      ctx.ui.setStatus(statusId, "by the way…");

      const result = await runSideQuery(question, ctx.cwd);
      ctx.ui.setStatus(statusId, "");

      if (!result || result.length === 0) {
        ctx.ui.notify("No result from side query.", "warning");
        return;
      }

      // Show in scrollable overlay
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const viewer = new ScrollViewer(result);
        const container = new Container();

        // Top border
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        // Title
        const title = question.length > 50 ? question.substring(0, 47) + "..." : question;
        container.addChild(new Text(theme.fg("accent", theme.bold(` /btw ${title}`)), 1, 0));

        // Spacer
        container.addChild(new Text("", 0, 0));

        // Content (wrapped in a component so it scrolls)
        const contentComp = {
          render: (w: number) => viewer.render(w),
          invalidate: () => viewer.invalidate(),
        };

        // We need to integrate handleInput with the container
        return {
          render: (w: number) => {
            const lines = container.render(w);
            const contentLines = contentComp.render(w);
            return [...lines, ...contentLines];
          },
          invalidate: () => {
            container.invalidate();
            viewer.invalidate();
          },
          handleInput: (data: string) => {
            const keepOpen = viewer.handleInput(data);
            if (!keepOpen) done();
            tui.requestRender();
          },
        };
      }, { overlay: true });

      // Clean up any status
      ctx.ui.setStatus(statusId, "");
    },
  });
}
