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


const YDOTOOL_SOCKET = process.env.YDOTOOL_SOCKET
  || (process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/.ydotool_socket` : "/run/user/1000/.ydotool_socket");

// ── helpers ─────────────────────────────────────────────────────────────────

function sh(cmd: string, timeout = 5_000): string {
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf-8", maxBuffer: 50*1024*1024, timeout });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `Command exited with code ${r.status}: ${cmd.substring(0, 80)}`);
  return r.stdout.trim();
}

function sudoSh(cmd: string, timeout = 5_000): string {
  return sh(`sudo YDOTOOL_SOCKET=${YDOTOOL_SOCKET} ${cmd}`, timeout);
}

/** Non-blocking promise-based sleep for use inside async execute() */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCursorPos(): { x: number; y: number } {
  const out = sh("hyprctl cursorpos");
  // Support optional negative coords just in case
  const m = out.match(/(-?\d+),\s*(-?\d+)/);
  if (m) return { x: parseInt(m[1]), y: parseInt(m[2]) };
  // If hyprctl output is unrecognized, throw so callers don't silently get (0,0)
  throw new Error(`Unable to parse cursor position from hyprctl output: "${out}"`);
}

function getScreenBounds(): { width: number; height: number; monitors: string; minX: number; minY: number } {
  const out = sh("hyprctl monitors");
  if (!out) throw new Error("hyprctl monitors returned no output");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const re = /(-?\d+)x(-?\d+)@[\d.]+ at (-?\d+)x(-?\d+)/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    const w = parseInt(m[1]), h = parseInt(m[2]);
    const x = parseInt(m[3]), y = parseInt(m[4]);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return { width: Math.max(maxX - minX, 2560), height: Math.max(maxY - minY, 1440), monitors: out, minX, minY };
}

/** Convert normalized (0-1000) coords to absolute pixel, accounting for monitor origin offset */
function normalizeToPixel(nx: number, ny: number, bound: { width: number; height: number; minX: number; minY: number }) {
  return {
    x: Math.round((nx / 1000) * bound.width + bound.minX),
    y: Math.round((ny / 1000) * bound.height + bound.minY),
  };
}

/** Clamp to screen bounds accounting for non-zero origin */
function clamp(x: number, y: number, bound: { width: number; height: number; minX: number; minY: number }) {
  return {
    x: Math.max(bound.minX, Math.min(x, bound.minX + bound.width - 1)),
    y: Math.max(bound.minY, Math.min(y, bound.minY + bound.height - 1)),
  };
}

// ── reliability helpers ────────────────────────────────────────────────────

/** Retry a ydotool action up to attempts times (default: 3) */
async function ydotoolRetry(action: string, attempts = 3, delayMs = 200): Promise<void> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      sudoSh(action, 5_000);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw lastErr || new Error(`ydotool failed after ${attempts} attempts`);
}

/** Move mouse and verify position (retry if not at target) */
async function moveToVerified(x: number, y: number, bound: { width: number; height: number; minX: number; minY: number }): Promise<void> {
  const { x: cx, y: cy } = clamp(x, y, bound);
  let lastPos: { x: number; y: number } | null = null;
  let readSucceeded = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    sudoSh(`ydotool mousemove -x ${cx} -y ${cy}`, 3_000);
    await sleep(50);
    try {
      const pos = getCursorPos();
      readSucceeded = true;
      lastPos = pos;
      // Accept if within 5px tolerance
      if (Math.abs(pos.x - cx) <= 5 && Math.abs(pos.y - cy) <= 5) return;
    } catch {
      // getCursorPos failed — may be transient; retry
    }
  }
  if (readSucceeded && lastPos) {
    throw new Error(
      `Failed to move mouse to (${cx}, ${cy}) after 3 attempts. ` +
      `Last known position: (${lastPos.x}, ${lastPos.y}) — still off-target. ` +
      `The mouse may not have moved correctly.`
    );
  } else {
    throw new Error(
      `Failed to move mouse to (${cx}, ${cy}) after 3 attempts. ` +
      `Could not read cursor position (getCursorPos failed each time). ` +
      `The mouse may not have moved correctly.`
    );
  }
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
      // Validate and convert region early
      let geometry: string | undefined;
      if (params.region) {
        const parts = params.region.split(",");
        if (parts.length !== 4) {
          return { content: [{ type: "text", text: "Invalid region: expected 'x,y,w,h' with exactly 4 comma-separated numbers." }], details: {}, isError: true };
        }
        const nums = parts.map(Number);
        for (let i = 0; i < 4; i++) {
          if (isNaN(nums[i])) {
            return { content: [{ type: "text", text: `Invalid region: '${parts[i]}' is not a valid number.` }], details: {}, isError: true };
          }
        }
        const [x, y, w, h] = nums;
        if (w <= 0 || h <= 0) {
          return { content: [{ type: "text", text: `Invalid region: width and height must be positive (got ${w}x${h}).` }], details: {}, isError: true };
        }
        // grim expects "<x>,<y> <w>x<h>"
        geometry = `${x},${y} ${w}x${h}`;
      }

      try {
        // Pipe grim to stdout (PNG) — no temp file, no cleanup needed
        const grimArgs = geometry ? ["-g", geometry, "-"] : ["-"];
        const data = execFileSync("grim", grimArgs, { maxBuffer: 50 * 1024 * 1024, timeout: 10_000 });
        const base64 = data.toString("base64");
        return {
          content: [
            { type: "text", text: `Screenshot captured (${(data.length / 1024).toFixed(0)} KB).` },
            { type: "image", data: `data:image/png;base64,${base64}`, mimeType: "image/png" },
          ],
          details: { size: data.length },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Screenshot failed: ${e.message}` }], details: {}, isError: true };
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

        await moveToVerified(tx, ty, bound);
        const final = clamp(tx, ty, bound);
        return { content: [{ type: "text", text: `Moved to (${final.x}, ${final.y})` }], details: { x: final.x, y: final.y } };
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
        await ydotoolRetry(`ydotool click ${btn}`);
        // Settle delay — ensures UI responds before next action
        await sleep(80);
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
        await moveToVerified(tx, ty, bound);
        const btn = params.button || 1;
        await ydotoolRetry(`ydotool click ${btn}`);
        await sleep(80);
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
        await ydotoolRetry("ydotool click --repeat 2 --next-delay 100 1");
        await sleep(100);
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
        const keys: string[] = [];

        for (const p of parts) {
          const trimmed = p.trim();
          if (["ctrl", "alt", "shift", "super", "logo", "win"].includes(trimmed)) {
            // Map common names to wtype's expected names
            const modName = trimmed === "super" || trimmed === "win" ? "logo" : trimmed;
            modifiers.push(modName);
          } else {
            keys.push(trimmed);
          }
        }

        if (keys.length === 0) {
          return { content: [{ type: "text", text: `Invalid combo "${params.combo}": no key specified.` }], details: {}, isError: true };
        }
        if (keys.length > 1) {
          return { content: [{ type: "text", text: `Invalid combo "${params.combo}": multiple non-modifier keys (${keys.join(", ")}). Use a single key with modifiers.` }], details: {}, isError: true };
        }

        // Build args array: wtype -M ctrl -M shift -k c
        const wtypeArgs: string[] = [];
        for (const mod of modifiers) {
          wtypeArgs.push("-M", mod);
        }
        wtypeArgs.push("-k", keys[0]);
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
        if (params.amount === 0) {
          return { content: [{ type: "text", text: "Scroll amount is 0 — nothing to do." }], details: { amount: 0 } };
        }
        const dir = params.amount > 0 ? 4 : 5; // 4=up, 5=down
        const count = Math.min(Math.ceil(Math.abs(params.amount)), 20); // Round up fractional, cap at 20
        for (let i = 0; i < count; i++) {
          await ydotoolRetry(`ydotool click ${dir}`, 3, 50);
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
      // Track whether mousedown was issued so we can release it on error
      let mouseDown = false;
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
        await ydotoolRetry("ydotool mousedown 1");
        mouseDown = true;
        await sleep(50);
        // Use moveToVerified for reliable movement with retry
        await moveToVerified(tx, ty, bound);
        await ydotoolRetry("ydotool mouseup 1");
        mouseDown = false;
        return {
          content: [{ type: "text", text: `Dragged from (${start.x},${start.y}) to (${tx},${ty})` }],
          details: { from: start, to: { x: tx, y: ty } },
        };
      } catch (e: any) {
        // Always attempt to release the mouse button if we pressed it down
        if (mouseDown) {
          try { sudoSh("ydotool mouseup 1", 2_000); } catch { /* best effort */ }
        }
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
