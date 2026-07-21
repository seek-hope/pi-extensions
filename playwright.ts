/**
 * Playwright extension for pi — wraps the official Playwright library (Microsoft).
 * Official upstream: https://github.com/microsoft/playwright
 * Uses globally installed playwright module via child process.
 * Browser must be installed: npx playwright install chromium
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

const NODE_PATH = process.env.HOME + "/.npm/lib/node_modules";

// Escape a string for safe interpolation into a single-quoted JS string.
// Also escapes template literal backticks and dollar-brace.
function jsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

function runPlaywright(jsBody: string, cwd: string): string {
  const script = `
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    ${jsBody}
  } finally {
    await browser.close();
  }
})();
`;
  return execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, NODE_PATH },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "playwright_snapshot",
    label: "Playwright Snapshot",
    description: "Open a URL and capture a text snapshot of the page (accessibility tree)",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load and snapshot" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const url = jsEscape(params.url);
        const js = `await page.goto('${url}'); const t = await page.title(); const b = await page.evaluate("document.body.innerText"); console.log("Title: " + t + "\\n\\n" + (b || "").substring(0, 5000));`;
        const out = runPlaywright(js, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "playwright_eval",
    label: "Playwright Evaluate JS",
    description: "Navigate to URL and evaluate JavaScript in the page",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load" }),
      script: Type.String({ description: "JavaScript expression to evaluate" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const url = jsEscape(params.url);
        const script = jsEscape(params.script);
        const js = `await page.goto('${url}'); const result = await page.evaluate(() => { ${script} }); console.log(JSON.stringify(result, null, 2));`;
        const out = runPlaywright(js, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "playwright_click",
    label: "Playwright Click",
    description: "Navigate to URL and click an element described by text/selector",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load" }),
      target: Type.String({ description: "Element description, e.g. 'Sign in button' or css selector '.login'" }),
      snapshotAfter: Type.Optional(Type.Boolean({ description: "Return page snapshot after click (default: true)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const url = jsEscape(params.url);
        const target = jsEscape(params.target);
        const js = `
          await page.goto('${url}');
          try {
            await page.click('${target}');
          } catch {
            await page.click('text=${target}');
          }
          ${params.snapshotAfter !== false
            ? "const b = await page.evaluate('document.body.innerText'); console.log((b || '').substring(0, 3000));"
            : "console.log('Clicked.');"
          }
        `;
        const out = runPlaywright(js, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "playwright_fill",
    label: "Playwright Fill Form",
    description: "Navigate to URL and fill a form field",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load" }),
      target: Type.String({ description: "Field description or selector" }),
      text: Type.String({ description: "Text to fill" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const url = jsEscape(params.url);
        const target = jsEscape(params.target);
        const text = jsEscape(params.text);
        const js = `
          await page.goto('${url}');
          try {
            await page.fill('${target}', '${text}');
          } catch {
            await page.fill('text=${target}', '${text}');
          }
          const b = await page.evaluate('document.body.innerText');
          console.log((b || '').substring(0, 3000));
        `;
        const out = runPlaywright(js, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });
}
