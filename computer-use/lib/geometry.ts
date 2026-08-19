/**
 * Screen geometry helpers for computer use (pure functions, unit-testable).
 */

export interface ScreenBounds {
	width: number;
	height: number;
	monitors: string;
	minX: number;
	minY: number;
}

/** Extract combined screen bounds from raw `hyprctl monitors` output. */
export function parseScreenBounds(out: string): ScreenBounds {
	if (!out) throw new Error("hyprctl monitors returned no output");
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const re = /(-?\d+)x(-?\d+)@[\d.]+ at (-?\d+)x(-?\d+)/g;
	for (let m = re.exec(out); m !== null; m = re.exec(out)) {
		const w = parseInt(m[1], 10);
		const h = parseInt(m[2], 10);
		const x = parseInt(m[3], 10);
		const y = parseInt(m[4], 10);
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + w);
		maxY = Math.max(maxY, y + h);
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
		throw new Error(`Unable to parse monitor geometry from hyprctl monitors output: "${out.substring(0, 200)}"`);
	}
	return { width: maxX - minX, height: maxY - minY, monitors: out, minX, minY };
}

/** Convert normalized (0-1000) coords to absolute pixels, accounting for monitor origin offset. */
export function normalizeToPixel(
	nx: number,
	ny: number,
	bound: { width: number; height: number; minX: number; minY: number },
): { x: number; y: number } {
	if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
		throw new Error(`Invalid normalized coordinates: (${nx}, ${ny}) — must be finite numbers`);
	}
	return {
		x: Math.round((nx / 1000) * bound.width + bound.minX),
		y: Math.round((ny / 1000) * bound.height + bound.minY),
	};
}

/** Clamp to screen bounds accounting for non-zero origin. Non-finite input maps to the origin. */
export function clamp(
	x: number,
	y: number,
	bound: { width: number; height: number; minX: number; minY: number },
): { x: number; y: number } {
	if (!Number.isFinite(x)) x = bound.minX;
	if (!Number.isFinite(y)) y = bound.minY;
	return {
		x: Math.max(bound.minX, Math.min(x, bound.minX + bound.width - 1)),
		y: Math.max(bound.minY, Math.min(y, bound.minY + bound.height - 1)),
	};
}

/** Validate a "x,y,w,h" region string into grim's "<x>,<y> <w>x<h>" geometry form. */
export function parseRegion(region: string): { geometry?: string; error?: string } {
	const parts = region.split(",");
	if (parts.length !== 4) {
		return { error: "Invalid region: expected 'x,y,w,h' with exactly 4 comma-separated numbers." };
	}
	const nums = parts.map(Number);
	for (let i = 0; i < 4; i++) {
		if (!Number.isFinite(nums[i])) {
			return { error: `Invalid region: '${parts[i]}' is not a valid finite number.` };
		}
	}
	const [x, y, w, h] = nums;
	if (w <= 0 || h <= 0) {
		return { error: `Invalid region: width and height must be positive (got ${w}x${h}).` };
	}
	return { geometry: `${x},${y} ${w}x${h}` };
}
