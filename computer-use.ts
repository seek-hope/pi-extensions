/**
 * Computer Use extension — let pi control the desktop (screenshot, mouse, keyboard).
 *
 * Built for Hyprland/Wayland on Linux. Uses:
 *   grim     — screenshots (Wayland)
 *   ydotool  — mouse movement, clicking, scrolling
 *   wtype    — keyboard text input and key combos
 *   hyprctl  — cursor position, screen info
 *
 * Coordinate systems:
 *   absolute  — pixel coordinates (e.g. 960, 540)
 *   normalized — 0-1000 scale mapped to screen bounds (Claude Code compatible)
 *   relative  — offset from current cursor position
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── helpers ─────────────────────────────────────────────────────────────────

function sh(cmd: string, timeout = 5_000): string {
  try { return spawnSync("sh", ["-c", cmd], { encoding: "utf-8", maxBuffer: 50*1024*1024, timeout }).stdout.trim(); }
  catch { return ""; }
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
  let maxX = 0, maxY = 0;
  const re = /(\d+)x(\d+)@[\d.]+ at (\d+)x(\d+)/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    const w = parseInt(m[1]), h = parseInt(m[2]);
    const x = parseInt(m[3]), y = parseInt(m[4]);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return { width: maxX || 2560, height: maxY || 1440, monitors: out };
}

/** Convert normalized coordinates (0-1000 scale) to absolute pixel coords */
function normalizeToPixel(nx: number, ny: number, bound: { width: number; height: number }) {
  return {
    x: Math.round((nx / 1000) * bound.width),
    y: Math.round((ny / 1000) * bound.height),
  };
}

/** Clamp coordinates to screen bounds */
function clamp(x: number, y: number, bound: { width: number; height: number }) {
  return {
    x: Math.max(0, Math.min(x, bound.width - 1)),
    y: Math.max(0, Math.min(y, bound.height - 1)),
  };
}

// ── reliability helpers ────────────────────────────────────────────────────

/** Check if ydotool daemon is running */
function ydotoolOK(): boolean {
  try {
    spawnSync("sudo", ["YDOTOOL_SOCKET=/tmp/.ydotool_socket", "ydotool", "mousemove", "-x", "0", "-y", "0"], {
      encoding: "utf-8", stdio: "ignore", timeout: 2_000
    });
    return true;
  } catch { return false; }
}

/** Retry a ydotool action up to maxRetries times with delay */
function ydotoolRetry(action: string, maxRetries = 3, delayMs = 200): void {
  let lastErr: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      sudoSh(action, 5_000);
      return;
    } catch (e) { lastErr = e; if (i < maxRetries - 1) { const _sleep = spawnSync("sleep", [(delayMs / 1000).toString()], { timeout: delayMs + 500 }); } }
  }
  throw lastErr || new Error(`ydotool failed after ${maxRetries} retries`);
}

/** Move mouse and verify position (retry if not at target) */
function moveToVerified(x: number, y: number, bound: { width: number; height: number }): void {
  const { x: cx, y: cy } = clamp(x, y, bound);
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      sudoSh(`ydotool mousemove -x ${cx} -y ${cy}`, 3_000);
      // Small settle delay
      const _sleep = spawnSync("sleep", ["0.05"], { timeout: 200 });
      const pos = getCursorPos();
      // Accept if within 5px tolerance
      if (Math.abs(pos.x - cx) <= 5 && Math.abs(pos.y - cy) <= 5) return;
      if (attempt === 2) return; // Last attempt — accept anyway
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`Failed to move to (${cx}, ${cy})`);
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
    label: "Computer Move",
    description:
      "Move the mouse cursor. Supports 3 coordinate systems:\n" +
      "- absolute pixel: pass x, y as raw pixel values\n" +
      "- normalized (Claude Code compatible): set `coordSystem: 'normalized'`, x/y are 0-1000\n" +
      "- relative: set `coordSystem: 'relative'`, x/y are pixel offsets from current position",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate (pixels, or 0-1000 if normalized)" }),
      y: Type.Number({ description: "Y coordinate (pixels, or 0-1000 if normalized)" }),
      coordSystem: Type.Optional(Type.String({ description: "'absolute' (default), 'normalized' (0-1000), or 'relative'" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const bound = getScreenBounds();
        let tx = params.x, ty = params.y;

        if (params.coordSystem === "normalized") {
          ({ x: tx, y: ty } = normalizeToPixel(params.x, params.y, bound));
        } else if (params.coordSystem === "relative") {
          const pos = getCursorPos();
          tx = pos.x + params.x;
          ty = pos.y + params.y;
        }

        moveToVerified(tx, ty, bound);
        return { content: [{ type: "text", text: `Moved to (${tx}, ${ty})` }], details: { x: tx, y: ty } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Move failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── click ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "computer_click",
    label: "Computer Click",
    description: "Click the mouse at the current position. Button: left=1, middle=2, right=3. Adds a small settle delay after click for reliability.",
    parameters: Type.Object({
      button: Type.Optional(Type.Number({ description: "Mouse button: 1=left, 2=middle, 3=right (default: 1=left)" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const btn = params.button || 1;
        ydotoolRetry(`ydotool click ${btn}`);
        // Settle delay — ensures UI responds before next action
        const _sleep = spawnSync("sleep", ["0.08"], { timeout: 200 });
        const pos = getCursorPos();
        return { content: [{ type: "text", text: `Clicked button ${btn} at (${pos.x}, ${pos.y})` }], details: { button: btn, ...pos } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Click failed: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── combined move + click (one-shot for reliability) ─────────────────
  pi.registerTool({
    name: "computer_click_at",
    label: "Computer Click At",
    description: "Move mouse to a position then click. Use normalized coords (0-1000) for Claude Code compatible workflows.",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate" }),
      y: Type.Number({ description: "Y coordinate" }),
      button: Type.Optional(Type.Number({ description: "Mouse button: 1=left, 2=middle, 3=right (default: 1=left)" })),
      coordSystem: Type.Optional(Type.String({ description: "'absolute' (default), 'normalized' (0-1000), or 'relative'" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const bound = getScreenBounds();
        let tx = params.x, ty = params.y;
        if (params.coordSystem === "normalized") {
          ({ x: tx, y: ty } = normalizeToPixel(params.x, params.y, bound));
        } else if (params.coordSystem === "relative") {
          const pos = getCursorPos();
          tx = pos.x + params.x;
          ty = pos.y + params.y;
        }
        moveToVerified(tx, ty, bound);
        const btn = params.button || 1;
        ydotoolRetry(`ydotool click ${btn}`);
        const _sleep = spawnSync("sleep", ["0.08"], { timeout: 200 });
        const pos = getCursorPos();
        return { content: [{ type: "text", text: `Clicked button ${btn} at (${pos.x}, ${pos.y})` }], details: { button: btn, x: tx, y: ty } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Click-at failed: ${e.message}` }], details: {}, isError: true };
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
        ydotoolRetry("ydotool click --repeat 2 --next-delay 100 1");
        const _sleep = spawnSync("sleep", ["0.1"], { timeout: 200 });
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
        // Pass text via stdin (-) to avoid shell escaping issues entirely
        execFileSync("wtype", ["-"], {
          encoding: "utf-8",
          maxBuffer: 50 * 1024 * 1024,
          timeout: 10_000,
          input: params.text,
        });
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
          } else if (!key) {
            key = trimmed;
          }
        }

        if (!key) {
          return { content: [{ type: "text", text: "Invalid combo: no key specified." }], details: {}, isError: true };
        }

        // Build args array: wtype -M ctrl -M shift -k c  (or just key if no modifiers)
        const wtypeArgs: string[] = [];
        for (const mod of modifiers) {
          wtypeArgs.push("-M", mod);
        }
        wtypeArgs.push("-k", key);
        execFileSync("wtype", wtypeArgs, { encoding: "utf-8", maxBuffer: 5 * 1024, timeout: 5_000 });
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
        const count = Math.min(Math.abs(params.amount), 20); // Cap at 20 for sanity
        for (let i = 0; i < count; i++) {
          ydotoolRetry(`ydotool click ${dir}`, 2, 50);
        }
        const pos = getCursorPos();
        return { content: [{ type: "text", text: `Scrolled ${params.amount > 0 ? "up" : "down"} ${count} at (${pos.x}, ${pos.y})` }], details: { amount: params.amount, ...pos } };
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
      coordSystem: Type.Optional(Type.String({ description: "'absolute' (default), 'normalized' (0-1000), or 'relative'" })),
    }),
    async execute(_id, params, _signal) {
      try {
        const bound = getScreenBounds();
        let tx = params.toX, ty = params.toY;
        if (params.coordSystem === "normalized") {
          ({ x: tx, y: ty } = normalizeToPixel(params.toX, params.toY, bound));
        } else if (params.coordSystem === "relative") {
          const pos = getCursorPos();
          tx = pos.x + params.toX;
          ty = pos.y + params.toY;
        }
        ({ x: tx, y: ty } = clamp(tx, ty, bound));

        const start = getCursorPos();
        ydotoolRetry("ydotool mousedown 1");
        const _s1 = spawnSync("sleep", ["0.05"], { timeout: 200 });
        sudoSh(`ydotool mousemove -x ${tx} -y ${ty}`, 3_000);
        const _s2 = spawnSync("sleep", ["0.05"], { timeout: 200 });
        ydotoolRetry("ydotool mouseup 1");
        return {
          content: [{ type: "text", text: `Dragged from (${start.x},${start.y}) to (${tx},${ty})` }],
          details: { from: start, to: { x: tx, y: ty } },
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
