/**
 * Auto-Update extension for pi — keeps official tools up-to-date.
 * Updates both the extension code (git pull) and the underlying official tools.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const EXT_DIR = (process.env.HOME || homedir()) + "/.pi/agent/extensions";

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd: cwd || EXT_DIR,
    encoding: "utf-8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 120_000,
  });
}

export default function (pi: ExtensionAPI) {
  // ── /update-tools command ───────────────────────────────────────────
  pi.registerCommand("update-tools", {
    description: "Update extension code (git pull) and all underlying official tools",
    handler: async (_args, ctx) => {
      const results: string[] = [];
      let anyError = false;

      const safeSh = (cmd: string, cwd?: string): { ok: boolean; out: string } => {
        try {
          const out = sh(cmd, cwd);
          return { ok: true, out };
        }
        catch (e: any) { return { ok: false, out: e.stderr || e.message }; }
      };

      // 1. Git pull extension updates
      ctx.ui.notify("Updating extension code...", "info");
      results.push("=== Extension Code (git pull) ===");
      const r1 = safeSh("git pull origin main 2>&1 || echo 'No remote configured. Commit: '$(git rev-parse HEAD)");
      results.push(r1.out);
      if (!r1.ok) anyError = true;

      // 2. Update npm global tools
      ctx.ui.notify("Updating npm tools...", "info");
      results.push("\n=== npm global tools ===");
      const npmTools = [
        "@colbymchenry/codegraph",
        "@sentropic/graphify",
        "playwright",
        "typescript-language-server",
        "pyright",
        "context7",
        "doc-relay",
      ];
      for (const pkg of npmTools) {
        results.push(`--- ${pkg} ---`);
        const r2 = safeSh(`npm update -g ${pkg} 2>&1 || npm install -g ${pkg}@latest 2>&1`);
        results.push(r2.out);
        if (!r2.ok) anyError = true;
      }

      // 3. Update playwright browsers
      ctx.ui.notify("Updating Playwright browsers...", "info");
      results.push("\n=== Playwright Browsers ===");
      const r3 = safeSh("NODE_PATH=" + (process.env.HOME || homedir()) + "/.npm/lib/node_modules npx playwright install chromium 2>&1");
      results.push(r3.out);
      if (!r3.ok) anyError = true;

      // 4. Update serena (uv)
      ctx.ui.notify("Updating serena...", "info");
      results.push("\n=== Serena ===");
      const r4 = safeSh("uv tool upgrade serena-agent 2>&1 || echo 'uv tool upgrade not available'");
      results.push(r4.out);
      if (!r4.ok) anyError = true;

      // 5. Update gh CLI (system)
      ctx.ui.notify("Updating gh CLI...", "info");
      results.push("\n=== gh CLI ===");
      const r5 = safeSh("gh --version 2>&1 && (sudo -n apt update -qq -o APT::Status-Fd=0 2>/dev/null && sudo -n apt install -y gh 2>&1) || echo 'apt not available, manual update required'");
      results.push(r5.out);
      if (!r5.ok) anyError = true;

      // 6. Update rust-analyzer
      results.push("\n=== rust-analyzer ===");
      const r6 = safeSh("rustup component add rust-analyzer 2>&1 || echo 'rustup not available'");
      results.push(r6.out);
      if (!r6.ok) anyError = true;

      ctx.ui.notify(anyError ? "Some tools failed to update (see output)" : "All tools updated!", anyError ? "error" : "info");
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
        try { results.push(fn()); }
        catch (e: any) { results.push(`Error: ${e.stderr || e.message}`); }
      };

      if (scope === "all" || scope === "extensions") {
        run("Extension Code (git pull)", () => sh("git pull origin main 2>&1 || echo 'No remote. Local commit: '$(git rev-parse --short HEAD)"));
      }

      if (scope === "all" || scope === "npm") {
        run("npm: @colbymchenry/codegraph", () => sh("npm install -g @colbymchenry/codegraph@latest 2>&1"));
        run("npm: @sentropic/graphify", () => sh("npm install -g @sentropic/graphify@latest 2>&1"));
        run("npm: playwright", () => sh("npm install -g playwright@latest 2>&1"));
        run("npm: typescript-language-server", () => sh("npm install -g typescript-language-server@latest 2>&1"));
        run("npm: pyright", () => sh("npm install -g pyright@latest 2>&1"));
        run("npm: context7", () => sh("npm install -g context7@latest 2>&1"));
        run("npm: doc-relay", () => sh("npm install -g doc-relay@latest 2>&1"));
      }

      if (scope === "all" || scope === "playwright") {
        run("Playwright Browsers", () => sh("NODE_PATH=" + (process.env.HOME || homedir()) + "/.npm/lib/node_modules npx playwright install chromium 2>&1"));
      }

      if (scope === "all" || scope === "serena") {
        run("Serena (uv)", () => sh("uv tool upgrade serena-agent 2>&1 || echo 'uv not available, try: uv tool upgrade serena-agent'"));
      }

      if (scope === "all" || scope === "system") {
        run("System: grim (screenshots)", () => sh("pacman -Q grim 2>&1 || echo 'not via pacman'"));
        run("System: ydotool (mouse)", () => sh("pacman -Q ydotool 2>&1 || echo 'not via pacman'"));
        run("System: wtype (keyboard)", () => sh("pacman -Q wtype 2>&1 || echo 'not via pacman'"));
        run("System: tmux", () => sh("tmux -V 2>&1"));
        run("gh CLI", () => sh("(sudo -n apt update -qq -o APT::Status-Fd=0 2>/dev/null && sudo -n apt install -y gh 2>&1) || echo 'gh version:' $(gh --version | head -1)"));
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
      let remote = "";
      try { remote = sh("git remote get-url origin 2>/dev/null", EXT_DIR).trim(); } catch { /* no remote configured */ }
      if (remote && !remote.includes("Error")) {
        // Derive default branch name from remote HEAD
        let defaultBranch = "main";
        try {
          const headRef = sh("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null", EXT_DIR).trim();
          if (headRef && !headRef.includes("Error")) {
            defaultBranch = headRef.replace("refs/remotes/origin/", "");
          }
        } catch { /* fall back to main */ }
        // Check if behind remote
        sh(`git fetch origin ${defaultBranch} 2>/dev/null`, EXT_DIR);
        const behind = sh(`git rev-list HEAD..origin/${defaultBranch} --count 2>/dev/null`, EXT_DIR).trim();
        if (behind && behind !== "0" && !behind.includes("Error")) {
          ctx.ui.notify(`Extensions: ${behind} commit(s) behind remote. Run /update-tools to sync.`, "warning");
        }
      }
    } catch {
      // Silently ignore update check failures
    }
  });
}
