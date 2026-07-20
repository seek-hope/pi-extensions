/**
 * Sub-agent extension for pi — multi-agent delegation system.
 *
 * Inspired by Claude Code "ultracode", Kimi "agent swarm", Codex "/ultra".
 *
 * Architecture:
 *   Main Agent (current session)
 *     ├── spawn sub-agents (parallel or sequential)
 *     ├── each sub-agent runs as isolated pi -p process
 *     ├── results collected and returned to main agent
 *     └── supports chaining, parallel fan-out, and review patterns
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── types ───────────────────────────────────────────────────────────────────

interface SubAgent {
  id: string;
  task: string;
  status: "running" | "done" | "error" | "cancelled";
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  workDir: string;
  proc?: ChildProcess;
  model?: string;
  tools?: string[];
}

const subAgents = new Map<string, SubAgent>();

function nextId(): string {
  return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── spawn a sub-agent pi process ────────────────────────────────────────────

function spawnSubAgent(
  task: string,
  cwd: string,
  options?: {
    model?: string;
    tools?: string[];
    systemPrompt?: string;
    modelRuntime?: any;
  }
): { id: string; promise: Promise<string> } {
  const id = nextId();
  const workDir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
  const startTime = Date.now();

  // Write task to a file for context
  const taskFile = join(workDir, "TASK.md");
  writeFileSync(taskFile, `# Sub-agent Task\n\n${task}\n\n---\nWork in: ${workDir}`);

  const agent: SubAgent = {
    id,
    task,
    status: "running",
    startTime,
    workDir,
    model: options?.model,
    tools: options?.tools,
  };
  subAgents.set(id, agent);

  const promise = new Promise<string>((resolve) => {
    const args: string[] = [
      "-p",
      "--no-context-files",
      "--no-session",
      "--cwd", workDir,
    ];

    if (options?.model) {
      args.push("--model", options.model);
    }
    if (options?.tools) {
      args.push("--tools", options.tools.join(","));
    }
    if (options?.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    // The task itself
    args.push(task);

    const env = { ...process.env };
    const proc = spawn("pi", args, {
      cwd: workDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    agent.proc = proc;

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      agent.endTime = Date.now();
      if (agent.status === "cancelled") return;
      agent.status = code === 0 ? "done" : "error";
      if (code === 0) {
        agent.result = stdout.trim();
        resolve(stdout.trim());
      } else {
        agent.error = stderr.trim() || `exit code ${code}`;
        resolve(`[Sub-agent error] ${agent.error}\n\nPartial output:\n${stdout.trim()}`);
      }
      // Clean up work dir
      try { rmSync(workDir, { recursive: true }); } catch { /* ignore */ }
    });

    proc.on("error", (err) => {
      agent.status = "error";
      agent.error = err.message;
      resolve(`[Sub-agent spawn error] ${err.message}`);
      try { rmSync(workDir, { recursive: true }); } catch { /* ignore */ }
    });

    // 5 minute timeout
    setTimeout(() => {
      if (agent.status === "running") {
        proc.kill();
        if (agent.status === "running") {
          agent.status = "error";
          agent.error = "timeout (5 min)";
          resolve(`[Sub-agent timeout after 5 minutes]\n\nPartial output:\n${stdout.trim()}`);
        }
      }
    }, 300_000);
  });

  return { id, promise };
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /subagent command ──────────────────────────────────────────────────
  pi.registerCommand("subagent", {
    description:
      "Sub-agent management: spawn parallel agents, chain tasks, review workflows",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0];
      const rest = parts.slice(1).join(" ");

      switch (subcmd) {
        case "spawn": {
          if (!rest) { ctx.ui.notify("Usage: /subagent spawn <task>", "warning"); return; }
          const { id } = spawnSubAgent(rest, ctx.cwd);
          ctx.ui.notify(`Sub-agent ${id} spawned`, "info");
          // Wait and show result
          ctx.ui.setStatus(id, `sub-agent ${id} running…`);
          const ag = subAgents.get(id);
          if (ag) {
            // Poll for completion
            const check = () => {
              const a = subAgents.get(id);
              if (!a || a.status === "done" || a.status === "error" || a.status === "cancelled") {
                const result = a?.result || a?.error || "(no result)";
                ctx.ui.setStatus(id, "");
                ctx.ui.setWidget(id, [
                  `┌─ Sub-agent ${id} ──────────────────────────`,
                  `│ Task: ${(a?.task || "").substring(0, 50)}`,
                  `│ Status: ${a?.status}`,
                  `│ Time: ${a ? ((a.endTime || Date.now()) - a.startTime) / 1000 : 0}s`,
                  ...(a?.result || a?.error || "").split("\n").map((l: string) => `│ ${l}`),
                  `└──────────────────────────────────────────────`,
                ]);
                return;
              }
              setTimeout(check, 1000);
            };
            check();
          }
          return;
        }
        case "list": {
          if (subAgents.size === 0) {
            ctx.ui.notify("No sub-agents running.", "info");
            return;
          }
          const lines = ["┌─ Running Sub-agents ───────────────────────"];
          for (const [id, a] of subAgents) {
            const elapsed = ((a.endTime || Date.now()) - a.startTime) / 1000;
            lines.push(`│ ${id}: [${a.status}] ${a.task.substring(0, 40)} (${elapsed.toFixed(1)}s)`);
          }
          lines.push("└───────────────────────────────────────────");
          ctx.ui.setWidget("subagent-list", lines);
          return;
        }
        case "cancel": {
          if (!rest) { ctx.ui.notify("Usage: /subagent cancel <id>", "warning"); return; }
          const ag = subAgents.get(rest);
          if (!ag) { ctx.ui.notify(`No sub-agent with id: ${rest}`, "error"); return; }
          ag.status = "cancelled";
          ag.proc?.kill();
          subAgents.delete(rest);
          ctx.ui.notify(`Sub-agent ${rest} cancelled.`, "info");
          return;
        }
        default: {
          ctx.ui.setWidget("subagent-help", [
            "┌─ /subagent ────────────────────────────────",
            "│ /subagent spawn <task>    Spawn a sub-agent",
            "│ /subagent list            List all sub-agents",
            "│ /subagent cancel <id>     Cancel a sub-agent",
            "│",
            "│ The AI can also use:",
            "│   subagent_spawn   — parallel fan-out",
            "│   subagent_wait    — wait for completion",
            "│   subagent_parallel — spawn N in parallel",
            "│   subagent_chain   — sequential chain",
            "└───────────────────────────────────────────",
          ]);
          return;
        }
      }
    },
  });

  // ── subagent_spawn tool ─────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Sub-agent",
    description:
      "Spawn a sub-agent to work on a task independently in an isolated context. " +
      "Use this to delegate work, search multiple sources in parallel, or explore alternatives. " +
      "Returns a subagent ID that can be used with subagent_wait to collect results.",
    parameters: Type.Object({
      task: Type.String({ description: "Task description for the sub-agent" }),
      model: Type.Optional(Type.String({ description: "Model override (e.g. 'gpt-4o-mini' for cheap tasks)" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist (e.g. 'read,bash,grep')" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for the sub-agent" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id, promise } = spawnSubAgent(params.task, ctx.cwd, {
        model: params.model,
        tools: params.tools ? params.tools.split(",").map((t: string) => t.trim()) : undefined,
        systemPrompt: params.systemPrompt,
      });
      return {
        content: [
          {
            type: "text",
            text: `Sub-agent spawned. ID: ${id}\nTask: ${params.task}\nModel: ${params.model || "default"}\n\nUse subagent_wait("${id}") to collect the result.`,
          },
        ],
        details: { subagentId: id },
      };
    },
  });

  // ── subagent_wait tool ──────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Sub-agent",
    description: "Wait for a sub-agent to complete and return its result.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID returned by subagent_spawn" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Max wait time in ms (default: 300000 = 5 min)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      const ag = subAgents.get(params.id);
      if (!ag) {
        return {
          content: [{ type: "text", text: `Sub-agent ${params.id} not found. It may have already completed and been cleaned up, or never existed.` }],
          details: {},
          isError: true,
        };
      }

      const timeout = params.timeoutMs || 300_000;
      const deadline = Date.now() + timeout;

      // Poll until done
      while (ag.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (ag.status !== "running") break;
      }

      if (ag.status === "running") {
        return {
          content: [{ type: "text", text: `Sub-agent ${params.id} still running after ${timeout / 1000}s. Task: ${ag.task}\nCheck again later or cancel with subagent_cancel.` }],
          details: { subagentId: params.id, status: "running" },
        };
      }

      const elapsed = ((ag.endTime || Date.now()) - ag.startTime) / 1000;
      subAgents.delete(params.id);

      return {
        content: [
          {
            type: "text",
            text: [
              `┌─ Sub-agent ${params.id} complete ──────────────────`,
              `│ Status: ${ag.status}`,
              `│ Elapsed: ${elapsed.toFixed(1)}s`,
              `│ Task: ${ag.task.substring(0, 100)}`,
              `├──────────────────────────────────────────────`,
              ag.result || ag.error || "(empty)",
              `└──────────────────────────────────────────────`,
            ].join("\n"),
          },
        ],
        details: { subagentId: params.id, status: ag.status, elapsed },
      };
    },
  });

  // ── subagent_parallel tool ──────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_parallel",
    label: "Parallel Sub-agents",
    description:
      "Spawn multiple sub-agents in parallel and wait for all to complete. " +
      "Use this for fan-out: searching multiple sources, checking multiple files, exploring alternatives simultaneously.",
    parameters: Type.Object({
      tasks: Type.String({ description: "JSON array of task strings, e.g. ['task1','task2','task3']" }),
      model: Type.Optional(Type.String({ description: "Model override for all sub-agents" })),
      maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent sub-agents (default: 5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let tasks: string[];
      try {
        tasks = JSON.parse(params.tasks);
        if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
      } catch {
        // fallback: split by newline
        tasks = params.tasks.split("\n").filter((t: string) => t.trim());
      }

      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks provided." }], details: {}, isError: true };
      }

      const maxCon = params.maxConcurrency || 5;
      const results: { task: string; id: string; result: string; status: string; elapsed: number }[] = [];

      // Process in batches
      for (let i = 0; i < tasks.length; i += maxCon) {
        const batch = tasks.slice(i, i + maxCon);
        const batchPromises = batch.map((task) => {
          const { id, promise } = spawnSubAgent(task, ctx.cwd, { model: params.model });
          return promise.then((result) => {
            const ag = subAgents.get(id);
            return {
              task,
              id,
              result,
              status: ag?.status || "done",
              elapsed: ((ag?.endTime || Date.now()) - (ag?.startTime || Date.now())) / 1000,
            };
          });
        });
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        // Clean up
        for (const r of batchResults) subAgents.delete(r.id);
      }

      const summary = [
        `=== ${results.length} sub-agents completed ===`,
        ...results.map(
          (r, i) =>
            `[${i + 1}] ${r.status === "done" ? "✓" : "✗"} (${r.elapsed.toFixed(1)}s) ${r.task.substring(0, 60)}`
        ),
        "",
        ...results.map((r, i) => `=== Result ${i + 1}: ${r.task.substring(0, 40)} ===\n${r.result}\n`),
      ];

      return { content: [{ type: "text", text: summary.join("\n") }], details: { count: results.length } };
    },
  });

  // ── subagent_chain tool ─────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent_chain",
    label: "Chain Sub-agents",
    description:
      "Run sub-agents sequentially, where each sub-agent receives the previous sub-agent's output as context. " +
      "Use this for pipelines: research → summarize → format, or generate → review → refine.",
    parameters: Type.Object({
      tasks: Type.String({ description: "JSON array of task strings, executed in order. Each gets the previous result as context." }),
      model: Type.Optional(Type.String({ description: "Model override" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let tasks: string[];
      try {
        tasks = JSON.parse(params.tasks);
      } catch {
        tasks = params.tasks.split("\n").filter((t: string) => t.trim());
      }

      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks provided." }], details: {}, isError: true };
      }

      let context = "";
      const results: string[] = [];

      for (const task of tasks) {
        const fullTask = context
          ? `${task}\n\n--- Previous sub-agent output ---\n${context.substring(0, 3000)}\n--- End previous output ---`
          : task;
        const { id, promise } = spawnSubAgent(fullTask, ctx.cwd, { model: params.model });
        const result = await promise;
        context = result;
        results.push(result);
        subAgents.delete(id);
      }

      const summary = [
        `=== Chained ${tasks.length} sub-agents ===`,
        ...tasks.map((t, i) => `  [${i + 1}] ${t.substring(0, 60)}`),
        "",
        `=== Final Result ===`,
        results[results.length - 1] || "(empty)",
        "",
        `=== All Results ===`,
        ...results.map((r, i) => `--- Step ${i + 1} ---\n${r.substring(0, 2000)}\n`),
      ];

      return { content: [{ type: "text", text: summary.join("\n") }], details: { steps: tasks.length } };
    },
  });

  // ── subagent_list / subagent_cancel tools ───────────────────────────────
  pi.registerTool({
    name: "subagent_list",
    label: "List Sub-agents",
    description: "List all currently running sub-agents.",
    parameters: Type.Object({}),
    async execute() {
      if (subAgents.size === 0) {
        return { content: [{ type: "text", text: "No sub-agents currently running." }], details: {} };
      }
      const lines = ["Running sub-agents:"];
      for (const [id, a] of subAgents) {
        const elapsed = (Date.now() - a.startTime) / 1000;
        lines.push(`  ${id}: [${a.status}] ${a.task.substring(0, 60)} (${elapsed.toFixed(1)}s)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Sub-agent",
    description: "Cancel a running sub-agent by ID.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent ID to cancel" }),
    }),
    async execute(_toolCallId, params) {
      const ag = subAgents.get(params.id);
      if (!ag) {
        return { content: [{ type: "text", text: `Sub-agent ${params.id} not found.` }], details: {}, isError: true };
      }
      ag.status = "cancelled";
      ag.proc?.kill();
      subAgents.delete(params.id);
      return { content: [{ type: "text", text: `Sub-agent ${params.id} cancelled.` }], details: {} };
    },
  });

  // ── session_shutdown cleanup ────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    for (const [id, ag] of subAgents) {
      ag.status = "cancelled";
      ag.proc?.kill();
    }
    subAgents.clear();
  });
}
