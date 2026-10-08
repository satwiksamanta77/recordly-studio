import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/paths/binaries", () => ({
	resolvePreferredWindowsNativeHelperPath: () => "/nonexistent/win-occlusion.exe",
}));

import {
	mapOcclusionToCanvas,
	resolveOcclusionExePath,
	type ScreenRect,
	startOcclusionTracker,
} from "./occlusion";
import type { SceneItem } from "./types";

const item: SceneItem = {
	sourceId: "src-1",
	x: 0,
	y: 0,
	width: 1600,
	height: 1200,
	visible: true,
};

// Target window occupies the top-left 800x600 of the screen.
const windowRect: ScreenRect = { x: 100, y: 100, w: 800, h: 600 };

describe("mapOcclusionToCanvas", () => {
	it("scales and offsets screen rects onto the item canvas rect", () => {
		const result = mapOcclusionToCanvas([{ x: 300, y: 250, w: 200, h: 150 }], windowRect, item);
		// scale 2x: (300-100)*2=400, (250-100)*2=300, 200*2=400, 150*2=300
		expect(result).toEqual([{ x: 400, y: 300, w: 400, h: 300 }]);
	});

	it("maps a window-aligned rect to the full item rect", () => {
		const result = mapOcclusionToCanvas([windowRect], windowRect, item);
		expect(result).toEqual([{ x: 0, y: 0, w: 1600, h: 1200 }]);
	});

	it("clips rects that extend past the item rect", () => {
		const result = mapOcclusionToCanvas([{ x: 100, y: 500, w: 800, h: 300 }], windowRect, item);
		// y: (500-100)*2=800, h=600 -> clipped to 800..1200
		expect(result).toEqual([{ x: 0, y: 800, w: 1600, h: 400 }]);
	});

	it("drops rects that do not intersect the item at all", () => {
		const result = mapOcclusionToCanvas(
			[
				{ x: 2000, y: 2000, w: 100, h: 100 }, // fully outside the window
				{ x: 100, y: 100, w: 0, h: 50 }, // zero width
			],
			windowRect,
			item,
		);
		expect(result).toEqual([]);
	});

	it("handles an offset item position", () => {
		const offsetItem: SceneItem = { ...item, x: 320, y: 0, width: 800, height: 600 };
		const result = mapOcclusionToCanvas(
			[{ x: 100, y: 100, w: 800, h: 600 }],
			windowRect,
			offsetItem,
		);
		expect(result).toEqual([{ x: 320, y: 0, w: 800, h: 600 }]);
	});
});

describe("resolveOcclusionExePath", () => {
	it("follows the prebundled native-helper path pattern", () => {
		expect(resolveOcclusionExePath()).toBe("/nonexistent/win-occlusion.exe");
	});
});

describe("startOcclusionTracker", () => {
	it("warns and returns a no-op stop when the exe is missing", () => {
		const warnings: string[] = [];
		const tracker = startOcclusionTracker({
			hwnds: ["0xABC"],
			getSceneItems: () => [],
			getSource: () => undefined,
			onMaskRects: () => {
				throw new Error("should not be called");
			},
			onWarning: (msg) => warnings.push(msg),
		});
		expect(warnings).toEqual([
			"win-occlusion.exe not found — window-capture blackout disabled",
		]);
		expect(() => tracker.stop()).not.toThrow();
	});

	it("never throws without an onWarning handler", () => {
		const tracker = startOcclusionTracker({
			hwnds: ["0xABC"],
			getSceneItems: () => [],
			getSource: () => undefined,
			onMaskRects: () => {},
		});
		expect(() => tracker.stop()).not.toThrow();
	});
});
