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
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a command is available in PATH. Returns its full path or null. */
function which(cmd: string): string | null {
  try {
    return execFileSync("which", [cmd], { encoding: "utf-8", timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run a CLI tool, returning its combined stdout+stderr.
 * Throws if the tool is not installed (ENOENT) so callers can fall back.
 * Non-zero exit codes are captured — they just mean diagnostics were reported.
 */
function run(cmd: string, args: string[], timeout = 30_000): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(`Tool not found: "${cmd}". Please install it to use this LSP feature.`);
    }
    // LSP tools exit non-zero when diagnostics found — capture stderr/stdout
    return ((e.stdout || "") + "\n" + (e.stderr || "")).trim();
  }
}

/** Read a file and extract the identifier word at line:character (both 0-based). */
function getWordAt(filePath: string, line: number, character: number): string | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    if (line < 0 || line >= lines.length) return null;
    const l = lines[line];
    if (character < 0 || character > l.length) return null;

    // Try regex-based identifier extraction first
    const wordRegex = /\b\w+\b/g;
    let match: RegExpExecArray | null;
    while ((match = wordRegex.exec(l)) !== null) {
      if (character >= match.index && character <= match.index + match[0].length) {
        return match[0];
      }
    }

    // Fallback: take contiguous \w chars around the cursor
    let start = character;
    let end = character;
    while (start > 0 && /\w/.test(l[start - 1])) start--;
    while (end < l.length && /\w/.test(l[end])) end++;
    const word = l.slice(start, end);
    return word || null;
  } catch {
    return null;
  }
}

/** Filter diagnostics output to only lines mentioning a specific 1-based line number. */
function filterDiagForLine(diagOutput: string, targetLine: number): string {
  const lines = diagOutput.split("\n");
  const relevant = lines.filter((l: string) => l.includes(`:${targetLine}:`));
  return relevant.join("\n");
}

/** Search for definitions of a symbol using ripgrep (falls back to grep). */
function findDefinitions(symbol: string, language: string, cwd?: string): string {
  if (!symbol) return "Could not determine symbol at cursor position.";

  const patterns: Record<string, string> = {
    python: `(def |class )${symbol}\\b`,
    cpp: `\\b${symbol}\\s*\\([^)]*\\)\\s*\\{`,
    c: `\\b${symbol}\\s*\\([^)]*\\)\\s*\\{`,
    rust: `(fn |struct |enum |trait |impl |type |mod )${symbol}\\b`,
    typescript: `(function |class |interface |type |const |let |var )${symbol}\\b`,
    ts: `(function |class |interface |type |const |let |var )${symbol}\\b`,
  };

  const pattern = patterns[language] || `\\b${symbol}\\b`;

  try {
    const args = ["--no-heading", "-n", "-E", pattern, "--max-count=10"];
    if (cwd) args.push(cwd);
    const result = execFileSync("rg", args, { encoding: "utf-8", timeout: 30_000 }).trim();
    return result || `No definitions found for "${symbol}".`;
  } catch (e: any) {
    if (e.code === "ENOENT") {
      try {
        const grepArgs = ["-rn", "-E", pattern, "-m", "10"];
        if (cwd) grepArgs.push(cwd);
        const result = execFileSync("grep", grepArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
        return result || `No definitions found for "${symbol}".`;
      } catch {
        return `No definitions found for "${symbol}".`;
      }
    }
    return ((e.stdout || "") + "\n" + (e.stderr || "")).trim() || `No definitions found for "${symbol}".`;
  }
}

/** Search for all references to a symbol using ripgrep (falls back to grep). */
function findReferences(symbol: string, _language: string, cwd?: string): string {
  if (!symbol) return "Could not determine symbol at cursor position.";

  const pattern = `\\b${symbol}\\b`;

  try {
    const args = ["--no-heading", "-n", pattern, "--max-count=50"];
    if (cwd) args.push(cwd);
    const result = execFileSync("rg", args, { encoding: "utf-8", timeout: 30_000 }).trim();
    return result || `No references found for "${symbol}".`;
  } catch (e: any) {
    if (e.code === "ENOENT") {
      try {
        const grepArgs = ["-rn", pattern, "-m", "50"];
        if (cwd) grepArgs.push(cwd);
        const result = execFileSync("grep", grepArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
        return result || `No references found for "${symbol}".`;
      } catch {
        return `No references found for "${symbol}".`;
      }
    }
    return ((e.stdout || "") + "\n" + (e.stderr || "")).trim() || `No references found for "${symbol}".`;
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- diagnostics ---------------------------------------------------------
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
        if (!existsSync(file)) return { content: [{ type: "text", text: `File not found: ${file}` }], details: {}, isError: true };

        let result = "";
        switch (lang) {
          case "python": {
            if (!which("pyright")) {
              return { content: [{ type: "text", text: "pyright not installed. Install with: pip install pyright" }], details: {}, isError: true };
            }
            result = run("pyright", [file], 60_000);
            break;
          }
          case "cpp":
          case "c":
          case "c++": {
            if (!which("clangd")) {
              return { content: [{ type: "text", text: "clangd not installed. Install via LLVM/clangd package." }], details: {}, isError: true };
            }
            result = run("clangd", [`--check=${file}`], 30_000);
            break;
          }
          case "rust": {
            // Try rust-analyzer first; fall back to cargo check if not installed
            if (which("rust-analyzer")) {
              result = run("rust-analyzer", ["diagnostics", file], 60_000);
            } else if (which("cargo")) {
              result = run("cargo", ["check"], 60_000);
            } else {
              return { content: [{ type: "text", text: "Neither rust-analyzer nor cargo found. Install Rust: https://rustup.rs" }], details: {}, isError: true };
            }
            break;
          }
          case "typescript":
          case "ts": {
            if (!which("tsc")) {
              return { content: [{ type: "text", text: "tsc not installed. Install with: npm install -g typescript" }], details: {}, isError: true };
            }
            result = run("tsc", ["--noEmit", "--pretty", "false", file], 60_000);
            break;
          }
          default:
            return { content: [{ type: "text", text: `Unknown language: ${lang}. Supported: python, cpp, rust, typescript` }], details: {}, isError: true };
        }
        return { content: [{ type: "text", text: result || "No diagnostics." }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  // ---- hover ---------------------------------------------------------------
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
        const line = params.line ?? 0;
        const col = params.character ?? 0;

        if (!file) return { content: [{ type: "text", text: "filePath required" }], details: {}, isError: true };
        if (!existsSync(file)) return { content: [{ type: "text", text: `File not found: ${file}` }], details: {}, isError: true };

        const word = getWordAt(file, line, col);
        const posLabel = `${file}:${line + 1}:${col + 1}`;
        const wordInfo = word ? ` Symbol: "${word}"` : "";

        // Run diagnostics and filter to the line under the cursor
        const hoverFromDiag = (tool: string, cmdArgs: string[], timeout: number): string => {
          const diagResult = run(tool, cmdArgs, timeout);
          const filtered = filterDiagForLine(diagResult, line + 1); // convert to 1-based for diag output
          if (filtered) return filtered;
          // No diagnostics at this line; return raw output (truncated) as context
          return `No diagnostics at line ${line + 1}.${wordInfo}\n\nRaw output (first 2000 chars):\n${diagResult.slice(0, 2000)}`;
        };

        switch (lang) {
          case "python": {
            if (!which("pyright")) {
              return { content: [{ type: "text", text: `pyright not installed. Install with: pip install pyright\n\nCursor at ${posLabel}${wordInfo}` }], details: {} };
            }
            return { content: [{ type: "text", text: hoverFromDiag("pyright", [file], 60_000) }], details: {} };
          }
          case "cpp":
          case "c":
          case "c++": {
            if (!which("clangd")) {
              return { content: [{ type: "text", text: `clangd not installed. Install via LLVM/clangd package.\n\nCursor at ${posLabel}${wordInfo}` }], details: {} };
            }
            return { content: [{ type: "text", text: hoverFromDiag("clangd", [`--check=${file}`], 30_000) }], details: {} };
          }
          case "rust": {
            if (!which("rust-analyzer")) {
              return { content: [{ type: "text", text: `rust-analyzer not installed.\n\nCursor at ${posLabel}${wordInfo}` }], details: {} };
            }
            return { content: [{ type: "text", text: hoverFromDiag("rust-analyzer", ["diagnostics", file], 60_000) }], details: {} };
          }
          case "typescript":
          case "ts": {
            if (!which("tsc")) {
              return { content: [{ type: "text", text: `tsc not installed. Install with: npm install -g typescript\n\nCursor at ${posLabel}${wordInfo}` }], details: {} };
            }
            return { content: [{ type: "text", text: hoverFromDiag("tsc", ["--noEmit", "--pretty", "false", file], 60_000) }], details: {} };
          }
          default:
            return { content: [{ type: "text", text: `Unknown language: ${lang}` }], details: {}, isError: true };
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  // ---- definition ----------------------------------------------------------
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
        const lang = (params.language || "").toLowerCase();
        const file = params.filePath || "";
        const line = params.line ?? 0;
        const col = params.character ?? 0;

        if (!file) return { content: [{ type: "text", text: "filePath required" }], details: {}, isError: true };
        if (!existsSync(file)) return { content: [{ type: "text", text: `File not found: ${file}` }], details: {}, isError: true };

        const word = getWordAt(file, line, col);
        if (!word) return { content: [{ type: "text", text: `Could not determine symbol at ${file}:${line + 1}:${col + 1}` }], details: {} };

        // Search from the file's directory; fall back to cwd
        const cwd = file.substring(0, file.lastIndexOf("/")) || undefined;
        const result = findDefinitions(word, lang, cwd);

        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });

  // ---- references ----------------------------------------------------------
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
        const lang = (params.language || "").toLowerCase();
        const file = params.filePath || "";
        const line = params.line ?? 0;
        const col = params.character ?? 0;

        if (!file) return { content: [{ type: "text", text: "filePath required" }], details: {}, isError: true };
        if (!existsSync(file)) return { content: [{ type: "text", text: `File not found: ${file}` }], details: {}, isError: true };

        const word = getWordAt(file, line, col);
        if (!word) return { content: [{ type: "text", text: `Could not determine symbol at ${file}:${line + 1}:${col + 1}` }], details: {} };

        const cwd = file.substring(0, file.lastIndexOf("/")) || undefined;
        const result = findReferences(word, lang, cwd);

        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], details: {}, isError: true };
      }
    },
  });
}
