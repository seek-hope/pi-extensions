/**
 * /btw command — ask a temporary question without affecting the current session.
 * Spawns a separate ephemeral pi invocation (print mode) so the side query and
 * its answer never touch the active session history.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Ask a temporary question without affecting the current session",
    handler: async (args, ctx) => {
      const question = args?.trim();
      if (!question || question.length === 0) {
        ctx.ui.notify("Usage: /btw <your question>", "warning");
        return;
      }

      // Show a brief indicator while the side query runs
      const statusId = "btw-" + Date.now();
      ctx.ui.setStatus(statusId, "by the way…");

      const result = await runSideQuery(question, ctx.cwd);
      ctx.ui.setStatus(statusId, "");

      // Show the answer in a custom widget above the editor
      ctx.ui.setWidget("btw-" + Date.now(), formatWidget(question, result));
    },
  });
}

// ── spawn pi in ephemeral print mode ────────────────────────────────────────

function runSideQuery(question: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      // Ensure API keys are available
      CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY || "",
      ANYSEARCH_API_KEY: process.env.ANYSEARCH_API_KEY || "",
      HF_API_KEY: process.env.HF_API_KEY || "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    };

    const child = spawn(
      "pi",
      [
        "-p",
        "--no-context-files",
        "--no-session",
        question,
      ],
      {
        cwd,
        env,
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
        resolve(stderr.trim() || `(pi exited with code ${code})`);
      }
    });

    child.on("error", (err) => {
      resolve(`Failed to spawn side query: ${err.message}`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      child.kill();
      if (!stdout.trim()) resolve("(side query timed out)");
    }, 120_000);
  });
}

// ── format the result for the widget ────────────────────────────────────────

function formatWidget(question: string, answer: string): string[] {
  const lines = [
    "┌─ /btw ──────────────────────────────────────",
    `│ Q: ${question.length > 60 ? question.substring(0, 57) + "..." : question}`,
    "├──────────────────────────────────────────────",
  ];

  // Split answer into lines, add margin
  for (const line of answer.split("\n")) {
    lines.push(`│ ${line}`);
  }

  lines.push("└──────────────────────────────────────────────");
  return lines;
}
