/**
 * Computer use — desktop automation (screenshot, mouse, keyboard) for
 * Hyprland/Wayland on Linux, as a core integration.
 *
 * Uses grim (screenshots), ydotool (mouse), wtype (keyboard), hyprctl (cursor
 * position, monitor info). Only loaded on supported platforms; see
 * isComputerUseSupported().
 */
import { spawn, spawnSync } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { clamp, normalizeToPixel, parseRegion, parseScreenBounds, type ScreenBounds } from "./geometry.ts";

let uid = 0;
try {
	uid = process.getuid?.() ?? 0;
} catch {
	uid = 0;
}
const YDOTOOL_SOCKET =
	process.env.YDOTOOL_SOCKET ||
	(process.env.XDG_RUNTIME_DIR
		? `${process.env.XDG_RUNTIME_DIR}/.ydotool_socket`
		: `/run/user/${uid}/.ydotool_socket`);

const SUDO_CACHE_TTL = 60_000;
const MAX_OUTPUT = 10 * 1024 * 1024;

/** Whether this platform supports the computer-use integration (Hyprland/Wayland + tools). */
export function isComputerUseSupported(): boolean {
	if (process.platform !== "linux") return false;
	if (!process.env.WAYLAND_DISPLAY && !process.env.HYPRLAND_INSTANCE_SIGNATURE) return false;
	for (const bin of ["grim", "ydotool", "wtype", "hyprctl"]) {
		try {
			const r = spawnSync("which", [bin], { stdio: "ignore" });
			if (r.status !== 0) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Non-blocking execFile returning stdout as a Buffer (10 MB cap). */
function execFileAsync(
	cmd: string,
	args: string[],
	options: { timeout?: number; input?: string } = {},
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => {
			size += d.length;
			if (size > MAX_OUTPUT) {
				child.kill();
				reject(new Error(`Output exceeded ${MAX_OUTPUT / 1024 / 1024}MB limit`));
				return;
			}
			chunks.push(d);
		});
		child.stdout?.on("error", () => {});
		child.stderr?.on("data", (d: Buffer) => {
			size += d.length;
			if (size > MAX_OUTPUT) {
				child.kill();
				reject(new Error(`Output exceeded ${MAX_OUTPUT / 1024 / 1024}MB limit`));
				return;
			}
			stderr += d.toString();
		});
		child.stderr?.on("error", () => {});
		const ms = options.timeout || 10_000;
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(Buffer.concat(chunks));
			else reject(new Error(stderr.trim() || `Command "${cmd}" exited with code ${code}`));
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		if (options.input) {
			child.stdin!.on("error", () => {});
			child.stdin!.end(options.input);
		}
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shAsync(cmd: string, timeout = 5_000): Promise<string> {
	const buf = await execFileAsync("sh", ["-c", cmd], { timeout });
	return buf.toString("utf-8").trim();
}

type CoordSystem = "absolute" | "normalized" | "relative";

function validateCoordSystem(raw: string | undefined): asserts raw is CoordSystem | undefined {
	if (raw !== undefined && !["absolute", "normalized", "relative"].includes(raw)) {
		throw new Error(`Invalid coordSystem: "${raw}". Must be "absolute", "normalized", or "relative".`);
	}
}

export class ComputerUseIntegration {
	readonly id = "computer-use";

	private sudoAvailable: boolean | null = null;
	private sudoCacheTime = 0;
	private sudoCheckPromise: Promise<void> | null = null;

	// No per-session state needed: all state lives in the desktop session itself.

	getDefaultActiveToolNames(): string[] {
		return [
			"computer_screenshot",
			"computer_move",
			"computer_click",
			"computer_click_at",
			"computer_double_click",
			"computer_type",
			"computer_key",
			"computer_scroll",
			"computer_drag",
			"computer_get_position",
			"computer_get_screen_size",
		];
	}

	getToolDefinitions(): ToolDefinition[] {
		return [
			this.createScreenshotTool() as ToolDefinition,
			this.createMoveTool() as ToolDefinition,
			this.createClickTool() as ToolDefinition,
			this.createClickAtTool() as ToolDefinition,
			this.createDoubleClickTool() as ToolDefinition,
			this.createTypeTool() as ToolDefinition,
			this.createKeyTool() as ToolDefinition,
			this.createScrollTool() as ToolDefinition,
			this.createDragTool() as ToolDefinition,
			this.createGetPositionTool() as ToolDefinition,
			this.createGetScreenSizeTool() as ToolDefinition,
		];
	}

	// ── backend ──────────────────────────────────────────────────────────

	private async ensureSudo(): Promise<void> {
		if (this.sudoAvailable === true && Date.now() - this.sudoCacheTime < SUDO_CACHE_TTL) return;
		if (this.sudoCheckPromise) {
			await this.sudoCheckPromise;
			if (this.sudoAvailable === true) return;
		}
		this.sudoCheckPromise = (async () => {
			try {
				await execFileAsync("sudo", ["-n", "true"], { timeout: 5_000 });
				this.sudoAvailable = true;
			} catch {
				this.sudoAvailable = false;
			}
			this.sudoCacheTime = Date.now();
		})();
		await this.sudoCheckPromise;
		this.sudoCheckPromise = null;
		if (!this.sudoAvailable) {
			throw new Error(
				"Passwordless sudo is not configured. ydotool requires root privileges for mouse/keyboard operations. " +
					"Run: echo 'ALL ALL=(ALL) NOPASSWD: /usr/bin/ydotool' | sudo tee /etc/sudoers.d/ydotool",
			);
		}
	}

	private async sudoSh(cmd: string, timeout = 5_000): Promise<string> {
		await this.ensureSudo();
		const buf = await execFileAsync("sudo", ["env", `YDOTOOL_SOCKET=${YDOTOOL_SOCKET}`, "sh", "-c", cmd], {
			timeout,
		});
		return buf.toString("utf-8").trim();
	}

	private async getCursorPos(): Promise<{ x: number; y: number }> {
		const out = await shAsync("hyprctl cursorpos");
		const m = out.match(/(-?\d+),\s*(-?\d+)/);
		if (m) return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
		throw new Error(`Unable to parse cursor position from hyprctl output: "${out}"`);
	}

	private async getScreenBounds(): Promise<ScreenBounds> {
		const out = await shAsync("hyprctl monitors");
		return parseScreenBounds(out);
	}

	private async ydotoolRetry(action: string, attempts = 3, delayMs = 200): Promise<void> {
		let lastErr: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				await this.sudoSh(action, 5_000);
				return;
			} catch (e) {
				lastErr = e;
				if (i < attempts - 1) await sleep(delayMs);
			}
		}
		throw lastErr || new Error(`ydotool failed after ${attempts} attempts`);
	}

	private async moveToVerified(
		x: number,
		y: number,
		bound: { width: number; height: number; minX: number; minY: number },
	): Promise<void> {
		const { x: cx, y: cy } = clamp(x, y, bound);
		let lastPos: { x: number; y: number } | null = null;
		let readSucceeded = false;
		let moveSucceeded = false;
		let lastErr: unknown = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this.sudoSh(`ydotool mousemove -x ${cx} -y ${cy}`, 3_000);
				moveSucceeded = true;
				await sleep(50);
				const pos = await this.getCursorPos();
				readSucceeded = true;
				lastPos = pos;
				if (Math.abs(pos.x - cx) <= 5 && Math.abs(pos.y - cy) <= 5) return;
			} catch (e) {
				lastErr = e;
			}
		}
		if (readSucceeded && lastPos) {
			throw new Error(
				`Failed to move mouse to (${cx}, ${cy}) after 3 attempts. ` +
					`Last known position: (${lastPos.x}, ${lastPos.y}) — still off-target. ` +
					"The mouse may not have moved correctly.",
			);
		}
		if (moveSucceeded) {
			const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
			throw new Error(
				`Mouse move to (${cx}, ${cy}) likely succeeded, but position could not be confirmed after 3 attempts. ` +
					`getCursorPos failed each time (last error: ${detail}). ` +
					`The cursor may be at (${cx}, ${cy}) despite the verification failure.`,
			);
		}
		const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
		throw new Error(
			`Mouse move to (${cx}, ${cy}) failed after 3 attempts. ydotool mousemove never returned successfully (last error: ${detail}).`,
		);
	}

	private async resolveTarget(
		x: number,
		y: number,
		coordSystem: CoordSystem | undefined,
		bound: ScreenBounds,
	): Promise<{ tx: number; ty: number }> {
		let tx = x;
		let ty = y;
		if (coordSystem === "normalized") {
			({ x: tx, y: ty } = normalizeToPixel(x, y, bound));
		} else if (coordSystem === "relative") {
			const pos = await this.getCursorPos();
			tx = pos.x + x;
			ty = pos.y + y;
		}
		return { tx, ty };
	}

	// ── tools ────────────────────────────────────────────────────────────

	private createScreenshotTool() {
		const schema = Type.Object({
			region: Type.Optional(
				Type.String({
					description: "Region to capture as 'x,y,w,h' (e.g. '0,0,1920,1080'). Omit for full screen.",
				}),
			),
		});
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_screenshot",
			label: "Computer Screenshot",
			description:
				"Take a screenshot of the entire desktop and return it as a base64-encoded PNG image. " +
				"Use this to understand what's on screen before taking action.",
			parameters: schema,
			async execute(_toolCallId, params) {
				let geometry: string | undefined;
				if (params.region) {
					const parsed = parseRegion(params.region);
					if (parsed.error) {
						return { content: [{ type: "text", text: parsed.error }], details: {}, isError: true };
					}
					geometry = parsed.geometry;
				}
				try {
					const grimArgs = geometry ? ["-g", geometry, "-"] : ["-"];
					const data = await execFileAsync("grim", grimArgs, { timeout: 10_000 });
					const base64 = data.toString("base64");
					return {
						content: [
							{ type: "text", text: `Screenshot captured (${(data.length / 1024).toFixed(0)} KB).` },
							{ type: "image", data: base64, mimeType: "image/png" },
						],
						details: { size: data.length },
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Screenshot failed: ${e.message}` }],
						details: {},
						isError: true,
					};
				}
			},
		};
		return definition;
	}

	private createMoveTool() {
		const schema = Type.Object({
			x: Type.Number({ description: "X coordinate (pixels, or 0-1000 if normalized)" }),
			y: Type.Number({ description: "Y coordinate (pixels, or 0-1000 if normalized)" }),
			coordSystem: Type.Optional(
				Type.String({ description: "'absolute' (default), 'normalized' (0-1000), or 'relative'" }),
			),
		});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_move",
			label: "Computer Move",
			description:
				"Move the mouse cursor. Supports 3 coordinate systems:\n" +
				"- absolute pixel: pass x, y as raw pixel values\n" +
				"- normalized (Claude Code compatible): set `coordSystem: 'normalized'`, x/y are 0-1000\n" +
				"- relative: set `coordSystem: 'relative'`, x/y are pixel offsets from current position",
			parameters: schema,
			async execute(_toolCallId, params) {
				try {
					if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
						throw new Error(`Invalid coordinates: (${params.x}, ${params.y}) — must be finite numbers`);
					}
					validateCoordSystem(params.coordSystem);
					const bound = await self.getScreenBounds();
					const { tx, ty } = await self.resolveTarget(params.x, params.y, params.coordSystem, bound);
					await self.moveToVerified(tx, ty, bound);
					const final = clamp(tx, ty, bound);
					return {
						content: [{ type: "text", text: `Moved to (${final.x}, ${final.y})` }],
						details: { x: final.x, y: final.y },
					};
				} catch (e: any) {
					return { content: [{ type: "text", text: `Move failed: ${e.message}` }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	private createClickTool() {
		const schema = Type.Object({
			button: Type.Optional(
				Type.Number({ description: "Mouse button: 1=left, 2=middle, 3=right (default: 1=left)" }),
			),
		});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_click",
			label: "Computer Click",
			description:
				"Click the mouse at the current position. Button: left=1, middle=2, right=3. Adds a small settle delay after click for reliability.",
			parameters: schema,
			async execute(_toolCallId, params) {
				try {
					const btn = params.button ?? 1;
					if (btn < 1 || btn > 3) {
						return {
							content: [
								{ type: "text", text: `Invalid button: ${btn}. Must be 1 (left), 2 (middle), or 3 (right).` },
							],
							details: {},
							isError: true,
						};
					}
					await self.ydotoolRetry(`ydotool click ${btn}`);
					await sleep(80);
					const pos = await self.getCursorPos();
					return {
						content: [{ type: "text", text: `Clicked button ${btn} at (${pos.x}, ${pos.y})` }],
						details: { button: btn, ...pos },
					};
				} catch (e: any) {
					return { content: [{ type: "text", text: `Click failed: ${e.message}` }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	private createClickAtTool() {
		const schema = Type.Object({
			x: Type.Number({ description: "X coordinate" }),
			y: Type.Number({ description: "Y coordinate" }),
			button: Type.Optional(
				Type.Number({ description: "Mouse button: 1=left, 2=middle, 3=right (default: 1=left)" }),
			),
			coordSystem: Type.Optional(
				Type.String({ description: "'absolute' (default), 'normalized' (0-1000), or 'relative'" }),
			),
		});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_click_at",
			label: "Computer Click At",
			description:
				"Move mouse to a position then click. Use normalized coords (0-1000) for Claude Code compatible workflows.",
			parameters: schema,
			async execute(_toolCallId, params) {
				try {
					if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
						throw new Error(`Invalid coordinates: (${params.x}, ${params.y}) — must be finite numbers`);
					}
					const btn = params.button ?? 1;
					if (btn < 1 || btn > 3) {
						return {
							content: [
								{ type: "text", text: `Invalid button: ${btn}. Must be 1 (left), 2 (middle), or 3 (right).` },
							],
							details: {},
							isError: true,
						};
					}
					validateCoordSystem(params.coordSystem);
					const bound = await self.getScreenBounds();
					const { tx, ty } = await self.resolveTarget(params.x, params.y, params.coordSystem, bound);
					await self.moveToVerified(tx, ty, bound);
					await self.ydotoolRetry(`ydotool click ${btn}`);
					await sleep(80);
					const pos = await self.getCursorPos();
					return {
						content: [{ type: "text", text: `Clicked button ${btn} at (${pos.x}, ${pos.y})` }],
						details: { button: btn, x: tx, y: ty },
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Click-at failed: ${e.message}` }],
						details: {},
						isError: true,
					};
				}
			},
		};
		return definition;
	}

	private createDoubleClickTool() {
		const schema = Type.Object({});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_double_click",
			label: "Computer Double Click",
			description: "Double-click the mouse at the current position.",
			parameters: schema,
			async execute() {
				try {
					await self.ydotoolRetry("ydotool click --repeat 2 --next-delay 100 1");
					await sleep(100);
					const pos = await self.getCursorPos();
					return {
						content: [{ type: "text", text: `Double-clicked at (${pos.x}, ${pos.y})` }],
						details: { ...pos },
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Double-click failed: ${e.message}` }],
						details: {},
						isError: true,
					};
				}
			},
		};
		return definition;
	}

	private createTypeTool() {
		const schema = Type.Object({
			text: Type.String({ description: "Text to type" }),
		});
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_type",
			label: "Computer Type",
			description: "Type text at the current keyboard focus using wtype (Wayland).",
			parameters: schema,
			async execute(_toolCallId, params) {
				try {
					const MAX_INPUT = 100 * 1024;
					if (params.text.length > MAX_INPUT) {
						return {
							content: [
								{
									type: "text",
									text: `Text too large (${params.text.length} bytes, max ${MAX_INPUT / 1024}KB)`,
								},
							],
							details: {},
							isError: true,
						};
					}
					await execFileAsync("wtype", ["-"], { timeout: 10_000, input: params.text });
					return {
						content: [{ type: "text", text: `Typed: ${params.text.substring(0, 100)}` }],
						details: { length: params.text.length },
					};
				} catch (e: any) {
					return { content: [{ type: "text", text: `Type failed: ${e.message}` }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	private createKeyTool() {
		const schema = Type.Object({
			combo: Type.String({ description: "Key combo like 'ctrl+c', 'alt+tab', 'super+d', 'ctrl+shift+escape'" }),
		});
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_key",
			label: "Computer Key Combo",
			description:
				"Press a key combination (e.g. 'ctrl+c', 'alt+tab', 'super+d'). Modifiers: ctrl, alt, shift, super.",
			parameters: schema,
			async execute(_toolCallId, params) {
				try {
					const parts = params.combo.split("+");
					const modifiers: string[] = [];
					const keys: string[] = [];
					for (const p of parts) {
						const trimmed = p.trim();
						if (trimmed.length === 0) continue;
						const lower = trimmed.toLowerCase();
						if (["ctrl", "alt", "shift", "super", "logo", "win"].includes(lower)) {
							modifiers.push(lower === "super" || lower === "win" ? "logo" : lower);
						} else {
							keys.push(trimmed);
						}
					}
					if (keys.length === 0) {
						return {
							content: [{ type: "text", text: `Invalid combo "${params.combo}": no key specified.` }],
							details: {},
							isError: true,
						};
					}
					if (keys.length > 1) {
						return {
							content: [
								{
									type: "text",
									text: `Invalid combo "${params.combo}": multiple non-modifier keys (${keys.join(", ")}). Use a single key with modifiers.`,
								},
							],
							details: {},
							isError: true,
						};
					}
					const wtypeArgs: string[] = [];
					for (const mod of modifiers) {
						wtypeArgs.push("-M", mod);
					}
					wtypeArgs.push("-k", keys[0]);
					await execFileAsync("wtype", wtypeArgs, { timeout: 5_000 });
					return {
						content: [{ type: "text", text: `Pressed: ${params.combo}` }],
						details: { combo: params.combo },
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Key combo failed: ${e.message}` }],
						details: {},
						isError: true,
					};
				}
			},
		};
		return definition;
	}

	private createScrollTool() {
		const schema = Type.Object({
			amount: Type.Number({ description: "Scroll amount: positive=up, negative=down (e.g. 3 or -5)" }),
		});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_scroll",
			label: "Computer Scroll",
			description: "Scroll the mouse wheel. Positive = up, negative = down.",
			parameters: schema,
			async execute(_toolCallId, params) {
				try {
					if (!Number.isFinite(params.amount)) {
						return {
							content: [
								{ type: "text", text: `Invalid scroll amount: ${params.amount} — must be a finite number.` },
							],
							details: {},
							isError: true,
						};
					}
					if (params.amount === 0) {
						return {
							content: [{ type: "text", text: "Scroll amount is 0 — nothing to do." }],
							details: { amount: 0 },
						};
					}
					const dir = params.amount > 0 ? 4 : 5;
					const count = Math.min(Math.ceil(Math.abs(params.amount)), 20);
					for (let i = 0; i < count; i++) {
						await self.ydotoolRetry(`ydotool click ${dir}`, 3, 50);
						if (i < count - 1) await sleep(15);
					}
					const pos = await self.getCursorPos();
					return {
						content: [
							{
								type: "text",
								text: `Scrolled ${params.amount > 0 ? "up" : "down"} ${count} at (${pos.x}, ${pos.y})`,
							},
						],
						details: { amount: params.amount, ...pos },
					};
				} catch (e: any) {
					return { content: [{ type: "text", text: `Scroll failed: ${e.message}` }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	private createDragTool() {
		const schema = Type.Object({
			toX: Type.Number({ description: "Target X coordinate" }),
			toY: Type.Number({ description: "Target Y coordinate" }),
			coordSystem: Type.Optional(
				Type.String({ description: "'absolute' (default), 'normalized' (0-1000), or 'relative'" }),
			),
		});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_drag",
			label: "Computer Drag",
			description: "Drag from current position to target coordinates.",
			parameters: schema,
			async execute(_toolCallId, params) {
				let mouseDown = false;
				try {
					if (!Number.isFinite(params.toX) || !Number.isFinite(params.toY)) {
						throw new Error(`Invalid coordinates: (${params.toX}, ${params.toY}) — must be finite numbers`);
					}
					validateCoordSystem(params.coordSystem);
					const bound = await self.getScreenBounds();
					let { tx, ty } = await self.resolveTarget(params.toX, params.toY, params.coordSystem, bound);
					({ x: tx, y: ty } = clamp(tx, ty, bound));
					const start = await self.getCursorPos();
					await self.ydotoolRetry("ydotool mousedown 1");
					mouseDown = true;
					await sleep(50);
					await self.moveToVerified(tx, ty, bound);
					await self.ydotoolRetry("ydotool mouseup 1");
					mouseDown = false;
					return {
						content: [{ type: "text", text: `Dragged from (${start.x},${start.y}) to (${tx},${ty})` }],
						details: { from: start, to: { x: tx, y: ty } },
					};
				} catch (e: any) {
					if (mouseDown) {
						try {
							await self.sudoSh("ydotool mouseup 1", 2_000);
						} catch {
							/* best effort */
						}
					}
					return { content: [{ type: "text", text: `Drag failed: ${e.message}` }], details: {}, isError: true };
				}
			},
		};
		return definition;
	}

	private createGetPositionTool() {
		const schema = Type.Object({});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_get_position",
			label: "Computer Get Position",
			description: "Get the current mouse cursor position.",
			parameters: schema,
			async execute() {
				try {
					const pos = await self.getCursorPos();
					return { content: [{ type: "text", text: `Cursor at (${pos.x}, ${pos.y})` }], details: pos };
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Position query failed: ${e.message}` }],
						details: {},
						isError: true,
					};
				}
			},
		};
		return definition;
	}

	private createGetScreenSizeTool() {
		const schema = Type.Object({});
		const self = this;
		const definition: ToolDefinition<typeof schema> = {
			name: "computer_get_screen_size",
			label: "Computer Get Screen Size",
			description: "Get the total desktop dimensions (all monitors combined).",
			parameters: schema,
			async execute() {
				try {
					const bounds = await self.getScreenBounds();
					return {
						content: [
							{
								type: "text",
								text: `Screen: ${bounds.width}x${bounds.height}\n\nMonitor details:\n${bounds.monitors}`,
							},
						],
						details: { width: bounds.width, height: bounds.height },
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Screen size query failed: ${e.message}` }],
						details: {},
						isError: true,
					};
				}
			},
		};
		return definition;
	}
}
