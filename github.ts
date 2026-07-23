/**
 * GitHub extension for pi - wraps the official gh CLI (github.com/cli/cli).
 * Official upstream: https://github.com/cli/cli
 * Requires: gh CLI installed and authenticated (gh auth login)
 */
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GH_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 1_000;
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes between temp dir scans
let lastCleanupTime = 0;

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "unknown error";
}

async function truncateOutput(output: string): Promise<string> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return output;
  }

  const summary = `${truncation.outputLines} of ${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}`;
  try {
    const directory = await mkdtemp(join(tmpdir(), "pi-gh-"));
    const outputPath = join(directory, "output.txt");
    await writeFile(outputPath, output, { encoding: "utf-8", mode: 0o600 });
    return `${truncation.content}\n\n[Output truncated: ${summary}. Full output saved to: ${outputPath}]`;
  } catch {
    return `${truncation.content}\n\n[Output truncated: ${summary}. Full output could not be saved.]`;
  } finally {
    // Clean up old temp dirs (>1h) to prevent accumulation.
    // Throttled: only scan every CLEANUP_INTERVAL_MS to avoid blocking the event loop
    // on every gh CLI call when /tmp has thousands of entries.
    const now = Date.now();
    if (now - lastCleanupTime > CLEANUP_INTERVAL_MS) {
      lastCleanupTime = now;
      try {
        for (const entry of readdirSync(tmpdir())) {
          if (!entry.startsWith("pi-gh-")) continue;
          const full = join(tmpdir(), entry);
          try { if (now - statSync(full).mtimeMs > 3_600_000) rmSync(full, { recursive: true, force: true }); } catch { /* ok */ }
        }
      } catch { /* best effort */ }
    }
  }
}

async function gh(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  let result;
  try {
    result = await pi.exec("gh", args, { cwd, signal, timeout: GH_TIMEOUT_MS });
  } catch (error: unknown) {
    throw new Error(`Failed to start GitHub CLI: ${unknownErrorMessage(error)}`);
  }

  if (result.killed) {
    throw new Error(
      signal?.aborted
        ? "GitHub CLI command was cancelled"
        : `GitHub CLI command timed out after ${GH_TIMEOUT_MS / 1_000} seconds`,
    );
  }
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim();
    throw new Error(message || `GitHub CLI exited with code ${result.code}`);
  }

  const output = result.stdout || result.stderr || "GitHub CLI command completed successfully.";
  return truncateOutput(output);
}

function requiredNumber(kind: "issue" | "pull request", number: number | undefined): number {
  if (number === undefined) {
    throw new Error(`A ${kind} number is required for this action`);
  }
  return number;
}

function encodeRepository(repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error("Repository must use the owner/repo format");
  }
  return repo; // gh CLI handles URL encoding internally
}

function encodeContentPath(path: string): string {
  if (path.startsWith("/")) {
    throw new Error("File path must be relative to the repository root");
  }

  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("File path contains an empty, '.' or '..' segment");
  }
  // URL-encode each path segment so special characters (spaces, #, ?, etc.)
  // don't break the /repos/{owner}/{repo}/contents/{path} endpoint URL.
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "github_issue",
    label: "GitHub Issue",
    description: "View or create GitHub issues using the official gh CLI",
    parameters: Type.Object({
      action: StringEnum(["view", "list", "create", "close"] as const),
      number: Type.Optional(Type.Integer({ minimum: 1, description: "Issue number (for view/close)" })),
      title: Type.Optional(Type.String({ minLength: 1, description: "Title (for create)" })),
      body: Type.Optional(Type.String({ description: "Body text (for create)" })),
      label: Type.Optional(Type.String({ minLength: 1, description: "Labels to add (comma-separated)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: "Max results for list (default 30)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args: string[] = ["issue", params.action];
      switch (params.action) {
        case "list":
          if (params.limit !== undefined) args.push("--limit", String(params.limit));
          break;
        case "create":
          if (!params.title?.trim()) throw new Error("A non-empty title is required to create an issue");
          args.push("--title", params.title);
          if (params.body !== undefined) args.push("--body", params.body);
          if (params.label !== undefined) args.push("--label", params.label);
          break;
        case "view":
        case "close":
          args.push(String(requiredNumber("issue", params.number)));
          break;
      }

      const out = await gh(pi, args, ctx.cwd, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "github_pr",
    label: "GitHub PR",
    description: "View or create GitHub pull requests using the official gh CLI",
    parameters: Type.Object({
      action: StringEnum(["view", "list", "create", "status", "checkout", "diff"] as const),
      number: Type.Optional(Type.Integer({ minimum: 1, description: "PR number (for view/diff/checkout)" })),
      base: Type.Optional(Type.String({ minLength: 1, description: "Base branch (for create)" })),
      head: Type.Optional(Type.String({ minLength: 1, description: "Head branch (for create)" })),
      title: Type.Optional(Type.String({ minLength: 1, description: "Title (for create; commit data is used when omitted)" })),
      body: Type.Optional(Type.String({ description: "Body text (for create)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: "Max results for list (default 30)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args: string[] = ["pr", params.action];
      switch (params.action) {
        case "list":
          if (params.limit !== undefined) args.push("--limit", String(params.limit));
          break;
        case "create":
          if (params.base !== undefined) args.push("--base", params.base);
          if (params.head !== undefined) args.push("--head", params.head);
          if (params.title !== undefined) {
            args.push("--title", params.title);
            if (params.body !== undefined) args.push("--body", params.body);
          } else if (params.body !== undefined) {
            throw new Error(
              "A title is required when providing a body for PR creation. " +
              "Use --fill (omit both title and body) to auto-generate from commits, " +
              "or provide a title alongside the body.",
            );
          } else {
            args.push("--fill");
          }
          break;
        case "checkout":
          args.push(String(requiredNumber("pull request", params.number)));
          break;
        case "view":
        case "diff":
          if (params.number !== undefined) args.push(String(params.number));
          break;
        case "status":
          break;
      }

      const out = await gh(pi, args, ctx.cwd, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "github_search",
    label: "GitHub Search",
    description: "Search code, commits, issues, or repos on GitHub via gh CLI",
    parameters: Type.Object({
      type: StringEnum(["code", "commits", "issues", "prs", "repos"] as const),
      query: Type.String({ minLength: 1, description: "Search query" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: "Max results (default 30)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!params.query.trim()) throw new Error("Search query must not be blank");

      const args: string[] = ["search", params.type];
      if (params.limit !== undefined) args.push("--limit", String(params.limit));
      args.push("--", params.query);

      const out = await gh(pi, args, ctx.cwd, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "github_read_file",
    label: "GitHub Read File",
    description: "Read a file from a GitHub repository via gh CLI",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$", description: "owner/repo (defaults to current repo)" })),
      path: Type.String({ minLength: 1, description: "File path in the repo" }),
      branch: Type.Optional(Type.String({ minLength: 1, description: "Branch/tag/commit (default: repository default branch)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const repository = params.repo ? encodeRepository(params.repo) : "{owner}/{repo}";
      const path = encodeContentPath(params.path);
      const ref = params.branch === undefined ? "" : `?ref=${encodeURIComponent(params.branch)}`;
      const endpoint = `/repos/${repository}/contents/${path}${ref}`;
      const args = ["api", "-H", "Accept: application/vnd.github.raw+json", endpoint];

      const out = await gh(pi, args, ctx.cwd, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}
