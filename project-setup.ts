/**
 * Project Setup extension — ensures essential project infrastructure is in place.
 *
 * On session start, checks and auto-enables:
 *   Git, CodeGraph, DocRelay, Serena
 *
 * These form the foundation for automated, intelligent code & documentation management.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── helpers ─────────────────────────────────────────────────────────────────

function sh(cmd: string, cwd: string): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
    });
    return { ok: true, out: out.trim() };
  } catch (e: any) {
    return { ok: false, out: e.stderr || e.message || "" };
  }
}

interface Check {
  name: string;
  icon: string;
  exists: (cwd: string) => boolean;
  init: (cwd: string) => { ok: boolean; out: string };
  description: string;
  skipInHome?: boolean;
}

// ── check definitions ──────────────────────────────────────────────────────

const checks: Check[] = [
  {
    name: "Git",
    icon: "🔀",
    exists: (cwd) => existsSync(join(cwd, ".git")),
    init: (cwd) => {
      const r1 = sh("git init", cwd);
      if (!r1.ok) return r1;
      const r2 = sh("git add -A", cwd);
      const r3 = sh(
        'git commit -m "pi: initial snapshot (auto-created for project management)" --allow-empty',
        cwd
      );
      return { ok: true, out: `git init done.\n${r2.out}\n${r3.out}` };
    },
    description: "Version control",
    skipInHome: true,  // Don't auto-init git in home directory
  },
  {
    name: "CodeGraph",
    icon: "🧬",
    exists: (cwd) => existsSync(join(cwd, ".codegraph")) || existsSync(join(cwd, ".codegraph.json")),
    init: (cwd) => sh("codegraph init", cwd),
    description: "Code intelligence index",
  },
  {
    name: "DocRelay",
    icon: "📚",
    exists: (cwd) => existsSync(join(cwd, ".docrelay")) || existsSync(join(cwd, ".docrelay.db")),
    init: (cwd) => sh("doc-relay init --no-hooks --no-integrate", cwd),
    description: "Documentation sync",
  },
  {
    name: "Serena",
    icon: "🔍",
    exists: (cwd) => existsSync(join(cwd, ".serena")),
    init: (cwd) => sh("serena project create --index", cwd),
    description: "Semantic code tools",
  },
];

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // On session start, check project infrastructure
  pi.on("session_start", async (event, ctx) => {
    // Only run on fresh startup or new session, not on reload
    if (event.reason !== "startup" && event.reason !== "new") return;

    const cwd = ctx.cwd;
    const missing: Check[] = [];

    for (const check of checks) {
      if (!check.exists(cwd)) {
        if (check.skipInHome && cwd === process.env.HOME) continue;
        missing.push(check);
      }
    }

    if (missing.length === 0) return;

    // Auto-init: no prompt, just do it
    const results: string[] = [];
    for (const check of missing) {
      ctx.ui.setStatus("project-setup", `Setting up ${check.name}…`);
      const r = check.init(cwd);
      if (r.ok) {
        results.push(`${check.icon} ${check.name} → enabled`);
      } else {
        results.push(`${check.icon} ${check.name} → FAILED: ${r.out.substring(0, 100)}`);
      }
    }
    ctx.ui.setStatus("project-setup", "");

    // Show summary widget
    if (results.length > 0) {
      ctx.ui.setWidget("project-setup", [
        "┌─ Project Setup ────────────────────────────",
        ...results.map((r) => `│ ${r}`),
        "└────────────────────────────────────────────",
      ]);
    }
  });

  // ── project_setup tool (AI can check/setup on demand) ──────────────────
  pi.registerTool({
    name: "project_setup",
    label: "Project Setup",
    description:
      "Check and auto-enable project infrastructure: Git, CodeGraph, DocRelay, Serena. " +
      "Returns status for each and initializes any that are missing.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const lines: string[] = ["=== Project Infrastructure ==="];
      let allOk = true;

      for (const check of checks) {
        if (check.skipInHome && ctx.cwd === process.env.HOME) {
          lines.push(`${check.icon} ${check.name}: ⏭ skipped (home directory)`);
          continue;
        }
        if (check.exists(ctx.cwd)) {
          lines.push(`${check.icon} ${check.name}: ✅ enabled`);
        } else {
          const r = check.init(ctx.cwd);
          if (r.ok) {
            lines.push(`${check.icon} ${check.name}: ⚡ auto-enabled`);
            lines.push(`   ${r.out.substring(0, 200)}`);
          } else {
            lines.push(`${check.icon} ${check.name}: ❌ failed`);
            lines.push(`   ${r.out.substring(0, 200)}`);
            allOk = false;
          }
        }
      }

      lines.push("");
      lines.push(allOk ? "All infrastructure ready." : "Some items failed. Check details above.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { allOk },
      };
    },
  });
}
