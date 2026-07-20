/**
 * Auto-Update extension for pi — keeps official tools up-to-date.
 * Updates both the extension code (git pull) and the underlying official tools.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

const EXT_DIR = process.env.HOME + "/.pi/agent/extensions";

function sh(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd: cwd || EXT_DIR,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (e: any) {
    return `Error: ${e.stderr || e.message}`;
  }
}

export default function (pi: ExtensionAPI) {
  // ── /update-tools command ───────────────────────────────────────────
  pi.registerCommand("update-tools", {
    description: "Update extension code (git pull) and all underlying official tools",
    handler: async (_args, ctx) => {
      const results: string[] = [];

      // 1. Git pull extension updates
      ctx.ui.notify("Updating extension code...", "info");
      results.push("=== Extension Code (git pull) ===");
      results.push(sh("git pull origin master 2>&1 || echo 'No remote configured. Commit: '$(git rev-parse HEAD)"));

      // 2. Update npm global tools
      ctx.ui.notify("Updating npm tools...", "info");
      results.push("\n=== npm global tools ===");
      const npmTools = [
        "@colbymchenry/codegraph",
        "playwright",
        "paddleocr",
        "typescript-language-server",
        "pyright",
        "context7",
        "@huggingface/inference",
      ];
      for (const pkg of npmTools) {
        results.push(`--- ${pkg} ---`);
        results.push(sh(`npm update -g ${pkg} 2>&1 || npm install -g ${pkg}@latest 2>&1`));
      }

      // 3. Update playwright browsers
      ctx.ui.notify("Updating Playwright browsers...", "info");
      results.push("\n=== Playwright Browsers ===");
      results.push(sh("NODE_PATH=" + process.env.HOME + "/.npm/lib/node_modules npx playwright install chromium 2>&1"));

      // 4. Update serena (uv)
      ctx.ui.notify("Updating serena...", "info");
      results.push("\n=== Serena ===");
      results.push(sh("uv tool upgrade serena-agent 2>&1 || echo 'uv tool upgrade not available'"));

      // 5. Update gh CLI (system)
      ctx.ui.notify("Updating gh CLI...", "info");
      results.push("\n=== gh CLI ===");
      results.push(sh("gh --version 2>&1 && (sudo apt update -qq && sudo apt install -y gh 2>&1) || echo 'apt not available, manual update required'"));

      // 6. Update rust-analyzer
      results.push("\n=== rust-analyzer ===");
      results.push(sh("rustup component add rust-analyzer 2>&1 || echo 'rustup not available'"));

      ctx.ui.notify("All tools updated!", "info");
      return results.join("\n");
    },
  });

  // ── update_tools tool (for AI to call) ────────────────────────────
  pi.registerTool({
    name: "update_tools",
    label: "Update Tools",
    description: "Update extension code (git pull) and all underlying official tools (npm, playwright, serena, etc.)",
    parameters: Type.Object({
      scope: Type.Optional(Type.String({ description: "all, extensions, npm, playwright, serena, system (default: all)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const scope = params.scope || "all";
      const results: string[] = [];

      const run = (label: string, fn: () => string) => {
        results.push(`\n=== ${label} ===`);
        results.push(fn());
      };

      if (scope === "all" || scope === "extensions") {
        run("Extension Code (git pull)", () => sh("git pull origin master 2>&1 || echo 'No remote. Local commit: '$(git rev-parse --short HEAD)"));
      }

      if (scope === "all" || scope === "npm") {
        run("npm: @colbymchenry/codegraph", () => sh("npm install -g @colbymchenry/codegraph@latest 2>&1"));
        run("npm: playwright", () => sh("npm install -g playwright@latest 2>&1"));
        run("npm: paddleocr", () => sh("npm install -g paddleocr@latest 2>&1"));
        run("npm: typescript-language-server", () => sh("npm install -g typescript-language-server@latest 2>&1"));
        run("npm: pyright", () => sh("npm install -g pyright@latest 2>&1"));
        run("npm: context7", () => sh("npm install -g context7@latest 2>&1"));
        run("npm: @huggingface/inference", () => sh("npm install -g @huggingface/inference@latest 2>&1"));
      }

      if (scope === "all" || scope === "playwright") {
        run("Playwright Browsers", () => sh("NODE_PATH=" + process.env.HOME + "/.npm/lib/node_modules npx playwright install chromium 2>&1"));
      }

      if (scope === "all" || scope === "serena") {
        run("Serena (uv)", () => sh("uv tool upgrade serena-agent 2>&1 || echo 'uv not available, try: uv tool upgrade serena-agent'"));
      }

      if (scope === "all" || scope === "system") {
        run("gh CLI", () => sh("(sudo apt update -qq 2>/dev/null && sudo apt install -y gh 2>&1) || echo 'gh version:' $(gh --version | head -1)"));
        run("rust-analyzer", () => sh("rustup component add rust-analyzer 2>&1 || echo 'version:' $(rust-analyzer --version 2>&1 | head -1)"));
        run("clangd", () => sh("clangd --version 2>&1 | head -1"));
      }

      return { content: [{ type: "text", text: results.join("\n") }], details: {} };
    },
  });

  // ── session_start: check for updates on startup ────────────────────
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    try {
      // Quick check if git has a remote configured
      const remote = sh("git remote get-url origin 2>/dev/null", EXT_DIR).trim();
      if (remote && !remote.includes("Error")) {
        // Check if behind remote
        sh("git fetch origin master 2>/dev/null", EXT_DIR);
        const behind = sh("git rev-list HEAD..origin/master --count 2>/dev/null", EXT_DIR).trim();
        if (behind && behind !== "0" && !behind.includes("Error")) {
          ctx.ui.notify(`Extensions: ${behind} commit(s) behind remote. Run /update-tools to sync.`, "warning");
        }
      }
    } catch {
      // Silently ignore update check failures
    }
  });
}
