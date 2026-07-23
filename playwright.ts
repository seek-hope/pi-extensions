/**
 * Playwright extension for pi — wraps the official Playwright library (Microsoft).
 * Official upstream: https://github.com/microsoft/playwright
 * Uses globally installed playwright module via child process.
 * Browser must be installed: npx playwright install chromium
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const GLOBAL_NODE_MODULES = join(homedir(), ".npm", "lib", "node_modules");
const NODE_PATH = [GLOBAL_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(delimiter);

type PlaywrightRequest =
  | { action: "snapshot"; url: string }
  | { action: "eval"; url: string; script: string }
  | { action: "click"; url: string; target: string; snapshotAfter: boolean }
  | { action: "fill"; url: string; target: string; text: string };

// The runner is static. Tool arguments arrive through stdin as JSON, so none of
// them are interpreted by a shell or interpolated into Node.js source.
const PLAYWRIGHT_RUNNER = String.raw`
const { inspect } = require("node:util");
const { chromium } = require("playwright");

const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

function errorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;

  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + "\n\n[Output truncated]";
}

function serialize(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) + "n" : item, 2);
  } catch {
    return inspect(value, { depth: 10, maxArrayLength: 1_000, maxStringLength: 20_000 });
  }
}

async function snapshot(page, maxBytes) {
  const title = await page.title();
  const body = page.locator("body");
  let tree = "";
  if (await body.count() > 0) {
    // Try ariaSnapshot with mode: "ai" (Playwright >= 1.59)
    // Fall back to ariaSnapshot without mode (Playwright 1.49-1.58)
    // Fall back to basic text extraction (older Playwright)
    try {
      tree = await body.ariaSnapshot({ mode: "ai" });
    } catch {
      try {
        tree = await body.ariaSnapshot();
      } catch {
        try {
          tree = await page.evaluate(() => document.body?.innerText || "");
        } catch {
          tree = "";
        }
      }
    }
  }
  return truncateUtf8("Title: " + title + "\n\n" + tree, maxBytes);
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (await candidate.count() > 0) return candidate.first();
  }
  return undefined;
}

async function findTarget(page, target, action) {
  try {
    const selector = page.locator(target);
    if (await selector.count() > 0) return selector.first();
  } catch {
    // A human-readable target is not necessarily a valid CSS selector.
  }

  const roleMatch = target.match(/^(.+)\s+(button|link|checkbox|radio|textbox|input|field|combobox|heading|tab|menuitem|option|listitem|switch|searchbox|spinbutton|slider|progressbar|separator|table|row|cell|grid|dialog|navigation|alert|tooltip|menu|img|treeitem)$/i);
  const role = roleMatch && ["input", "field"].includes(roleMatch[2].toLowerCase())
    ? "textbox"
    : roleMatch && roleMatch[2].toLowerCase();
  const roleLocator = role ? page.getByRole(role, { name: roleMatch[1], exact: true }) : undefined;

  const candidates = action === "fill"
    ? [
        roleLocator,
        page.getByLabel(target, { exact: true }),
        page.getByPlaceholder(target, { exact: true }),
        page.getByRole("textbox", { name: target, exact: true }),
        page.getByRole("combobox", { name: target, exact: true }),
      ]
    : [
        roleLocator,
        page.getByText(target, { exact: true }),
        page.getByText(target, { exact: false }),
      ];

  const locator = await firstExisting(candidates.filter(Boolean));
  if (!locator) throw new Error("No element matched target " + JSON.stringify(target));
  return locator;
}

async function main() {
  let request;
  try {
    request = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error("Invalid browser request: " + errorMessage(error));
  }

  if (!request || typeof request !== "object") throw new Error("Invalid browser request");
  if (typeof request.url !== "string" || request.url.trim() === "") throw new Error("A non-empty URL is required");
  // Only allow http/https URLs and reject control characters
  const trimmedUrl = request.url.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmedUrl)) {
    throw new Error("URL contains invalid control characters.");
  }
  const urlLower = trimmedUrl.toLowerCase();
  if (!urlLower.startsWith("http://") && !urlLower.startsWith("https://")) {
    throw new Error("Only http/https URLs are allowed. Got: " + trimmedUrl.substring(0, 50));
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await page.goto(trimmedUrl, { waitUntil: "domcontentloaded" });

    switch (request.action) {
      case "snapshot":
        process.stdout.write(await snapshot(page, 5_000));
        break;
      case "eval": {
        if (typeof request.script !== "string" || request.script.trim() === "") {
          throw new Error("A non-empty JavaScript expression is required");
        }
        const result = await page.evaluate(request.script);
        process.stdout.write(truncateUtf8(serialize(result), 50_000));
        break;
      }
      case "click": {
        if (typeof request.target !== "string" || request.target.trim() === "") {
          throw new Error("A non-empty click target is required");
        }
        await (await findTarget(page, request.target, "click")).click();
        process.stdout.write(request.snapshotAfter ? await snapshot(page, 3_000) : "Clicked.");
        break;
      }
      case "fill": {
        if (typeof request.target !== "string" || request.target.trim() === "") {
          throw new Error("A non-empty fill target is required");
        }
        if (typeof request.text !== "string") throw new Error("Fill text must be a string");
        await (await findTarget(page, request.target, "fill")).fill(request.text);
        process.stdout.write(await snapshot(page, 3_000));
        break;
      }
      default:
        throw new Error("Unknown browser action: " + String(request.action));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(errorMessage(error) + "\n");
  process.exitCode = 1;
});
`;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const URL_REGEX = /^https?:\/\/([^\s/:]+)(:\d+)?(\/[^\s]*)?$/i;

function validateUrl(url: unknown): string {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("A non-empty URL is required.");
  }
  const trimmed = url.trim();
  // Reject URLs with control characters or newlines that could bypass checks
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error("URL contains invalid control characters.");
  }
  if (!URL_REGEX.test(trimmed)) {
    throw new Error("Only valid http/https URLs are allowed. Got: " + trimmed.substring(0, 50));
  }
  return trimmed;
}

function runPlaywright(request: PlaywrightRequest, cwd: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("Playwright operation cancelled."));
  // Validate URL early before spawning the child process
  request = { ...request, url: validateUrl(request.url) };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(output ?? "");
    };

    let child;
    try {
      child = execFile(
        process.execPath,
        ["-e", PLAYWRIGHT_RUNNER],
        {
          cwd,
          encoding: "utf8",
          env: { ...process.env, NODE_PATH },
          maxBuffer: MAX_BUFFER_BYTES,
          signal,
          timeout: PROCESS_TIMEOUT_MS,
        },
        (error, stdout, stderr) => {
          if (!error) {
            finish(undefined, stdout);
            return;
          }

          const stderrText = stderr.trim();
          if (signal?.aborted) {
            finish(new Error("Playwright operation cancelled."));
          } else if (error.killed) {
            finish(new Error(`Playwright operation timed out after ${PROCESS_TIMEOUT_MS / 1_000} seconds.`));
          } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            finish(new Error(`Playwright output exceeded ${MAX_BUFFER_BYTES / (1024 * 1024)} MB buffer. Use a more specific selector or script.`));
          } else {
            finish(new Error((stderrText || error.message).slice(0, 12_000)));
          }
        },
      );
    } catch (error) {
      finish(new Error(errorText(error)));
      return;
    }

    if (!child.stdin) {
      child.kill();
      finish(new Error("Unable to send the browser request to the Playwright process."));
      return;
    }

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      child.kill();
      finish(new Error(`Unable to send the browser request: ${errorText(error)}`));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "playwright_snapshot",
    label: "Playwright Snapshot",
    description: "Open a URL and capture a text snapshot of the page (accessibility tree)",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load and snapshot", minLength: 1 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const out = await runPlaywright({ action: "snapshot", url: params.url }, ctx.cwd, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "playwright_eval",
    label: "Playwright Evaluate JS",
    description: "Navigate to URL and evaluate JavaScript in the page",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load", minLength: 1 }),
      script: Type.String({ description: "JavaScript expression to evaluate", minLength: 1 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const out = await runPlaywright({ action: "eval", url: params.url, script: params.script }, ctx.cwd, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "playwright_click",
    label: "Playwright Click",
    description: "Navigate to URL and click an element described by text/selector",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load", minLength: 1 }),
      target: Type.String({
        description: "Element description, e.g. 'Sign in button' or css selector '.login'",
        minLength: 1,
      }),
      snapshotAfter: Type.Optional(Type.Boolean({ description: "Return page snapshot after click (default: true)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const out = await runPlaywright(
        {
          action: "click",
          url: params.url,
          target: params.target,
          snapshotAfter: params.snapshotAfter !== false,
        },
        ctx.cwd,
        signal,
      );
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "playwright_fill",
    label: "Playwright Fill Form",
    description: "Navigate to URL and fill a form field",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load", minLength: 1 }),
      target: Type.String({ description: "Field description or selector", minLength: 1 }),
      text: Type.String({ description: "Text to fill" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const out = await runPlaywright(
        { action: "fill", url: params.url, target: params.target, text: params.text },
        ctx.cwd,
        signal,
      );
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}
