/**
 * GitHub extension for pi — wraps the official gh CLI (github.com/cli/cli).
 * Official upstream: https://github.com/cli/cli
 * Requires: gh CLI installed and authenticated (gh auth login)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

function gh(args: string[], cwd: string): string {
  return execSync(["gh", ...args].join(" "), {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "github_issue",
    label: "GitHub Issue",
    description: "View or create GitHub issues using the official gh CLI",
    parameters: Type.Object({
      action: Type.String({ description: "view, list, create, or close" }),
      number: Type.Optional(Type.Number({ description: "Issue number (for view/close)" })),
      title: Type.Optional(Type.String({ description: "Title (for create)" })),
      body: Type.Optional(Type.String({ description: "Body text (for create)" })),
      label: Type.Optional(Type.String({ description: "Labels to add (comma-separated)" })),
      limit: Type.Optional(Type.Number({ description: "Max results for list (default 30)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const args: string[] = ["issue", params.action];
        if (params.number) args.push(String(params.number));
        if (params.title) args.push("--title", params.title);
        if (params.body) args.push("--body", params.body);
        if (params.label) args.push("--label", params.label);
        if (params.limit) args.push("--limit", String(params.limit));
        const out = gh(args, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "github_pr",
    label: "GitHub PR",
    description: "View or create GitHub pull requests using the official gh CLI",
    parameters: Type.Object({
      action: Type.String({ description: "view, list, create, status, checkout, or diff" }),
      number: Type.Optional(Type.Number({ description: "PR number (for view/diff/checkout)" })),
      base: Type.Optional(Type.String({ description: "Base branch (for create)" })),
      head: Type.Optional(Type.String({ description: "Head branch (for create)" })),
      title: Type.Optional(Type.String({ description: "Title (for create)" })),
      body: Type.Optional(Type.String({ description: "Body text (for create)" })),
      limit: Type.Optional(Type.Number({ description: "Max results for list (default 30)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const args: string[] = ["pr", params.action];
        if (params.number) args.push(String(params.number));
        if (params.base) args.push("--base", params.base);
        if (params.head) args.push("--head", params.head);
        if (params.title) args.push("--title", params.title);
        if (params.body) args.push("--body", params.body);
        if (params.limit) args.push("--limit", String(params.limit));
        const out = gh(args, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "github_search",
    label: "GitHub Search",
    description: "Search code, commits, issues, or repos on GitHub via gh CLI",
    parameters: Type.Object({
      type: Type.String({ description: "code, commits, issues, prs, or repos" }),
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const args = ["search", params.type, params.query];
        if (params.limit) args.push("--limit", String(params.limit));
        const out = gh(args, ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "github_read_file",
    label: "GitHub Read File",
    description: "Read a file from a GitHub repository via gh CLI",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "owner/repo (defaults to current repo)" })),
      path: Type.String({ description: "File path in the repo" }),
      branch: Type.Optional(Type.String({ description: "Branch/tag/commit (default: default branch)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        let repoFlag = params.repo ? `--repo=${params.repo}` : "";
        let ref = params.branch || "HEAD";
        const out = gh(["api", repoFlag, `repos/{owner}/{repo}/contents/${params.path}?ref=${ref}`, "--jq", ".content", "|", "base64 -d"].filter(Boolean), ctx.cwd);
        // Alternative: use `gh api -H 'Accept: application/vnd.github.raw' /repos/{owner}/{repo}/contents/{path}`
        const args = ["api", "-H", "Accept: application/vnd.github.raw", `/repos/{owner}/{repo}/contents/${params.path}?ref=${ref}`];
        if (params.repo) {
          args.splice(1, 0, `--repo=${params.repo}`);
        }
        const out2 = gh(args, ctx.cwd);
        return { content: [{ type: "text", text: out2 }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.stderr || e.message }], details: {}, isError: true };
      }
    },
  });
}
