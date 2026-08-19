/**
 * Tests for computer-use screen geometry helpers.
 */
import { describe, expect, it } from "vitest";
import {
	clamp,
	normalizeToPixel,
	parseRegion,
	parseScreenBounds,
} from "../computer-use/lib/geometry.ts";

const MONITORS_SINGLE = `Monitor eDP-1 (ID 0):
	1920x1080@60.00 at 0x0
	make: BOE`;

const MONITORS_DUAL = `Monitor HDMI-A-1 (ID 0):
	2560x1440@144.00 at 0x0
Monitor DP-1 (ID 1):
	1920x1080@60.00 at 2560x300`;

describe("parseScreenBounds", () => {
	it("parses a single monitor", () => {
		const b = parseScreenBounds(MONITORS_SINGLE);
		expect(b).toMatchObject({ width: 1920, height: 1080, minX: 0, minY: 0 });
	});

	it("combines multiple monitors with origin offsets", () => {
		const b = parseScreenBounds(MONITORS_DUAL);
		expect(b).toMatchObject({ width: 2560 + 1920, height: 1440, minX: 0, minY: 0 });
	});

	it("handles negative origins", () => {
		const out = `Monitor DP-1 (ID 0):\n\t1920x1080@60.00 at -1920x0\nMonitor eDP-1 (ID 1):\n\t1920x1080@60.00 at 0x0`;
		const b = parseScreenBounds(out);
		expect(b).toMatchObject({ width: 3840, height: 1080, minX: -1920, minY: 0 });
	});

	it("throws on empty or unparseable output", () => {
		expect(() => parseScreenBounds("")).toThrow(/no output/);
		expect(() => parseScreenBounds("no geometry here")).toThrow(/Unable to parse/);
	});
});

describe("normalizeToPixel", () => {
	const bound = { width: 2000, height: 1000, minX: 100, minY: 50 };

	it("maps 0-1000 to pixels including origin offset", () => {
		expect(normalizeToPixel(0, 0, bound)).toEqual({ x: 100, y: 50 });
		expect(normalizeToPixel(1000, 1000, bound)).toEqual({ x: 2100, y: 1050 });
		expect(normalizeToPixel(500, 500, bound)).toEqual({ x: 1100, y: 550 });
	});

	it("rejects non-finite coordinates", () => {
		expect(() => normalizeToPixel(Number.NaN, 0, bound)).toThrow(/Invalid normalized/);
		expect(() => normalizeToPixel(0, Number.POSITIVE_INFINITY, bound)).toThrow(/Invalid normalized/);
	});
});

describe("clamp", () => {
	const bound = { width: 100, height: 100, minX: 10, minY: 20 };

	it("clamps to bounds including origin", () => {
		expect(clamp(0, 0, bound)).toEqual({ x: 10, y: 20 });
		expect(clamp(500, 500, bound)).toEqual({ x: 109, y: 119 });
		expect(clamp(50, 60, bound)).toEqual({ x: 50, y: 60 });
	});

	it("maps non-finite input to the origin", () => {
		expect(clamp(Number.NaN, Number.NaN, bound)).toEqual({ x: 10, y: 20 });
	});
});

describe("parseRegion", () => {
	it("parses x,y,w,h into grim geometry", () => {
		expect(parseRegion("0,0,1920,1080")).toEqual({ geometry: "0,0 1920x1080" });
		expect(parseRegion("10,20,300,200")).toEqual({ geometry: "10,20 300x200" });
	});

	it("rejects malformed regions", () => {
		expect(parseRegion("1,2,3").error).toBeTruthy();
		expect(parseRegion("1,2,3,4,5").error).toBeTruthy();
		expect(parseRegion("a,b,c,d").error).toBeTruthy();
		expect(parseRegion("0,0,0,100").error).toBeTruthy();
		expect(parseRegion("0,0,100,-5").error).toBeTruthy();
	});
});
