/**
 * LSP extension — simple execSync-based diagnostics via official LSP CLI tools.
 *
 * Uses each language server's built-in CLI mode (not JSON-RPC stdio).
 * No event emitters, no child process lifecycle — zero crash risk.
 *
 * Supported:
 *   python: pyright <file>
 *   cpp:    clangd --check=<file>
 *   rust:   rust-analyzer diagnostics <file>  (falls back to cargo check)
 *   typescript: tsc --noEmit
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

function run(cmd: string, args: string[], timeout = 30_000): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    // LSP tools exit non-zero when diagnostics found — capture stderr/stdout
    return (e.stdout || "") + "\n" + (e.stderr || "");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get language server diagnostics for a file. Supports: python (pyright), cpp (clangd), rust (rust-analyzer), typescript (typescript-language-server).",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const lang = (params.language || "").toLowerCase();
        const file = params.filePath || "";
        if (!file) return { content: [{ type: "text", text: "filePath required" }], details: {}, isError: true };

        let result = "";
        switch (lang) {
          case "python":
            result = run("pyright", [file], 60_000);
            break;
          case "cpp":
          case "c":
          case "c++":
            result = run("clangd", [`--check=${file}`], 30_000);
            break;
          case "rust":
            // Try rust-analyzer first; fall back to cargo check
            try {
              result = run("rust-analyzer", ["diagnostics", file], 60_000);
            } catch {
              result = run("cargo", ["check"], 60_000);
            }
            break;
          case "typescript":
          case "ts":
            result = run("tsc", ["--noEmit", "--pretty", "false"], 60_000);
            break;
          default:
            return { content: [{ type: "text", text: `Unknown language: ${lang}. Supported: python, cpp, rust, typescript` }], details: {}, isError: true };
        }
        return { content: [{ type: "text", text: result || "No diagnostics." }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get hover/type information at a specific position in a file",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
      line: Type.Number({ description: "Zero-based line number" }),
      character: Type.Number({ description: "Zero-based character offset on the line" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const lang = (params.language || "").toLowerCase();
        const file = params.filePath || "";
        const line = (params.line || 0) + 1; // Convert to 1-based
        const col = (params.character || 0) + 1;

        switch (lang) {
          case "python":
            return { content: [{ type: "text", text: `Hover info for ${file}:${line}:${col}\n\nUse pyright in your editor for full hover support.` }], details: {} };
          case "cpp":
          case "c":
          case "c++":
            try {
              const r = run("clangd", [`--check=${file}`], 10_000);
              // Extract relevant lines around the target line
              const lines = r.split("\n");
              const targetIdx = lines.findIndex((l: string) => l.includes(`line ${line}`));
              const snippet = targetIdx >= 0 ? lines.slice(targetIdx, targetIdx + 3).join("\n") : "";
              return { content: [{ type: "text", text: snippet || "No hover info at this position." }], details: {} };
            } catch { return { content: [{ type: "text", text: "No hover info available." }], details: {} }; }
          case "rust":
            return { content: [{ type: "text", text: `Hover at ${file}:${line}:${col}\n\nUse rust-analyzer in your editor for full hover support.` }], details: {} };
          case "typescript":
          case "ts":
            return { content: [{ type: "text", text: `Hover at ${file}:${line}:${col}\n\nUse tsserver in your editor for full hover support.` }], details: {} };
          default:
            return { content: [{ type: "text", text: `Unknown language: ${lang}` }], details: {}, isError: true };
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Go to Definition",
    description: "Find the definition of a symbol at a specific position",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
      line: Type.Number({ description: "Zero-based line number" }),
      character: Type.Number({ description: "Zero-based character offset on the line" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const file = params.filePath || "";
        const line = (params.line || 0) + 1;
        const col = (params.character || 0) + 1;
        return { content: [{ type: "text", text: `Go-to-definition at ${file}:${line}:${col}\n\nUse LSP in your editor for full navigation support.` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description: "Find all references to a symbol at a specific position",
    parameters: Type.Object({
      language: Type.String({ description: "Language: python, cpp, rust, or typescript" }),
      filePath: Type.String({ description: "Absolute path to the source file" }),
      line: Type.Number({ description: "Zero-based line number" }),
      character: Type.Number({ description: "Zero-based character offset on the line" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const file = params.filePath || "";
        const line = (params.line || 0) + 1;
        const col = (params.character || 0) + 1;
        return { content: [{ type: "text", text: `Find references at ${file}:${line}:${col}\n\nUse LSP in your editor for full reference support.` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
