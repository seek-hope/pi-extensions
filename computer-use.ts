/**
 * Computer Use extension — let pi control the desktop (screenshot, mouse, keyboard).
 *
 * Built for Hyprland/Wayland on Linux. Uses:
 *   grim     — screenshots (Wayland)
 *   ydotool  — mouse movement, clicking, scrolling
 *   wtype    — keyboard text input and key combos
 *   hyprctl  — cursor position, screen info
 *
 * Inspired by Anthropic Computer Use and GitHub Copilot Computer Use.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:path";
import { randomUUID } from "node:crypto";

// ── helpers ─────────────────────────────────────────────────────────────────

function sh(cmd: string, timeout = 5_000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    return e.stderr || e.message || "";
  }
}

function sudoSh(cmd: string, timeout = 5_000): string {
  return sh(`sudo YDOTOOL_SOCKET=/tmp/.ydotool_socket ${cmd}`, timeout);
}

function getCursorPos(): { x: number; y: number } {
  const out = sh("hyprctl cursorpos");
  const m = out.match(/(\d+),\s*(\d+)/);
  if (m) return { x: parseInt(m[1]), y: parseInt(m[2]) };
  return { x: 0, y: 0 };
}

function getScreenBounds(): { width: number; height: number; monitors: string } {
  const out = sh("hyprctl monitors");
  // Parse all monitor geometries to find total bounds
  let maxX = 0, maxY = 0;
  const re = /(\d+)x(\d+)@[\d.]+ at (\d+)x(\d+)/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    const w = parseInt(m[1]), h = parseInt(m[2]);
    const x = parseInt(m[3]), y = parseInt(m[4]);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return {
    width: maxX || 2560,
    height: maxY || 1440,
    monitors: out,
  };
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── screenshot ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_screenshot",
    label: "Computer Screenshot",
    description:
      "Take a screenshot of the entire desktop and return it as a base64-encoded PNG image. " +
      "Use this to understand what's on screen before taking action.",
    parameters: Type.Object({
      region: Type.Optional(Type.String({
        description: "Region to capture as 'x,y,w,h' (e.g. '0,0,1920,1080'). Omit for full screen.",
      })),
    }),
    async execute(_id, params, _signal) {
      const file = `${tmpdir()}/pi-screenshot-${randomUUID()}.png`;
      try {
        if (params.region) {
          const [x, y, w, h] = params.region.split(",").map(Number);
          sh(`grim -g "${x},${y} ${w}x${h}" "${file}"`);
        } else {
          sh(`grim "${file}"`);
        }

        if (!existsSync(file)) {
          return { content: [{ type: "text", text: "Screenshot failed: file not created." }], details: {}, isError: true };
        }

        const data = readFileSync(file);
        const base64 = data.toString("base64");
        return {
          content: [
            { type: "text", text: `Screenshot captured (${(data.length / 1024).toFixed(0)} KB).` },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
          ],
          details: { size: data.length },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Screenshot failed: ${e.message}` }], details: {}, isError: true };
      } finally {
        // Always clean up temp file
        try { unlinkSync(file); } catch { /* already gone */ }
      }
    },
  });

  // ── move mouse ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_move",
    label: "Computer Move Mouse",
    description: "Move the mouse cursor to absolute screen coordinates (x, y).",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate (pixels from left)" }),
      y: Type.Number({ description: "Y coordinate (pixels from top)" }),
    }),
    async execute(_id, params, _signal) {
      try {
        sudoSh(`ydotool mousemove -x ${params.x} -y ${params.y}`);
        return { content: [{ type: "text", text: `Moved to (${params.x}, ${params.y})` }], details: { x: params.x, y: params.y } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Move failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── click ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_click",
    label: "Computer Click",
    description: "Click the mouse at the current position. Button: left=1, middle=2, right=3.",
    parameters: Type.Object({
      button: Type.Optional(Type.Number({ description: "Mouse button: 1=left, 2=middle, 3=right (default: 1=left)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const btn = params.button || 1;
        sudoSh(`ydotool click ${btn}`);
        const pos = getCursorPos();
        return { content: [{ type: "text", text: `Clicked button ${btn} at (${pos.x}, ${pos.y})` }], details: { button: btn, ...pos } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Click failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── double click ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_double_click",
    label: "Computer Double Click",
    description: "Double-click the mouse at the current position.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal) {
      try {
        sudoSh("ydotool click --repeat 2 --next-delay 100 1");
        const pos = getCursorPos();
        return { content: [{ type: "text", text: `Double-clicked at (${pos.x}, ${pos.y})` }], details: { ...pos } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Double-click failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── type ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_type",
    label: "Computer Type",
    description: "Type text at the current keyboard focus using wtype (Wayland).",
    parameters: Type.Object({
      text: Type.String({ description: "Text to type" }),
    }),
    async execute(_id, params, _signal) {
      try {
        // Escape special characters for shell
        const escaped = params.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
        sh(`wtype "${escaped}"`, 10000);
        return { content: [{ type: "text", text: `Typed: ${params.text.substring(0, 100)}` }], details: { length: params.text.length } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Type failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── key combo ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_key",
    label: "Computer Key Combo",
    description: "Press a key combination (e.g. 'ctrl+c', 'alt+tab', 'super+d'). Modifiers: ctrl, alt, shift, super.",
    parameters: Type.Object({
      combo: Type.String({ description: "Key combo like 'ctrl+c', 'alt+tab', 'super+d', 'ctrl+shift+escape'" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const parts = params.combo.toLowerCase().split("+");
        const modifiers: string[] = [];
        let key = "";

        for (const p of parts) {
          const trimmed = p.trim();
          if (["ctrl", "alt", "shift", "super"].includes(trimmed)) {
            modifiers.push(trimmed);
          } else {
            key = trimmed;
          }
        }

        if (!key) {
          return { content: [{ type: "text", text: "Invalid combo: no key specified." }], details: {}, isError: true };
        }

        const modArgs = modifiers.map((m) => `-M ${m}`).join(" ");
        sh(`wtype ${modArgs} -m ${modifiers.join(" ")} ${key}`, 5000);
        return { content: [{ type: "text", text: `Pressed: ${params.combo}` }], details: { combo: params.combo } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Key combo failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── scroll ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_scroll",
    label: "Computer Scroll",
    description: "Scroll the mouse wheel. Positive = up, negative = down.",
    parameters: Type.Object({
      amount: Type.Number({ description: "Scroll amount: positive=up, negative=down (e.g. 3 or -5)" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const dir = params.amount > 0 ? 4 : 5; // 4=up, 5=down
        const count = Math.abs(params.amount);
        for (let i = 0; i < count; i++) {
          sudoSh(`ydotool click ${dir}`);
        }
        const pos = getCursorPos();
        return { content: [{ type: "text", text: `Scrolled ${params.amount > 0 ? "up" : "down"} ${count} clicks at (${pos.x}, ${pos.y})` }], details: { amount: params.amount, ...pos } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Scroll failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── drag ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_drag",
    label: "Computer Drag",
    description: "Drag from current position to target coordinates.",
    parameters: Type.Object({
      toX: Type.Number({ description: "Target X coordinate" }),
      toY: Type.Number({ description: "Target Y coordinate" }),
    }),
    async execute(_id, params, _signal) {
      try {
        const start = getCursorPos();
        sudoSh("ydotool mousedown 1");
        // Small delay for drag initiation
        await new Promise((r) => setTimeout(r, 50));
        sudoSh(`ydotool mousemove -x ${params.toX} -y ${params.toY}`);
        await new Promise((r) => setTimeout(r, 50));
        sudoSh("ydotool mouseup 1");
        return {
          content: [{ type: "text", text: `Dragged from (${start.x},${start.y}) to (${params.toX},${params.toY})` }],
          details: { from: start, to: { x: params.toX, y: params.toY } },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Drag failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── get position ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_get_position",
    label: "Computer Get Position",
    description: "Get the current mouse cursor position.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal) {
      try {
        const pos = getCursorPos();
        return { content: [{ type: "text", text: `Cursor at (${pos.x}, ${pos.y})` }], details: pos };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Position query failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── get screen size ──────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_get_screen_size",
    label: "Computer Get Screen Size",
    description: "Get the total desktop dimensions (all monitors combined).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal) {
      try {
        const bounds = getScreenBounds();
        return {
          content: [{ type: "text", text: `Screen: ${bounds.width}x${bounds.height}\n\nMonitor details:\n${bounds.monitors}` }],
          details: { width: bounds.width, height: bounds.height },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Screen size query failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });
}
