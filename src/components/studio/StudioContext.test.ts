import { describe, expect, it } from "vitest";
import { applyMove, defaultItemRect } from "./sceneUtils";
import type { SceneItem } from "./types";

function item(sourceId: string): SceneItem {
	return { sourceId, x: 0, y: 0, width: 1920, height: 1080, visible: true };
}

describe("applyMove", () => {
	it("moves a middle item up one layer (towards the top)", () => {
		const items = [item("a"), item("b"), item("c")];
		expect(applyMove(items, "b", "up").map((i) => i.sourceId)).toEqual(["a", "c", "b"]);
	});

	it("moves a middle item down one layer (towards the bottom)", () => {
		const items = [item("a"), item("b"), item("c")];
		expect(applyMove(items, "b", "down").map((i) => i.sourceId)).toEqual(["b", "a", "c"]);
	});

	it("keeps the topmost item in place when moving up", () => {
		const items = [item("a"), item("b"), item("c")];
		const result = applyMove(items, "c", "up");
		expect(result.map((i) => i.sourceId)).toEqual(["a", "b", "c"]);
		expect(result).toBe(items); // unchanged reference
	});

	it("keeps the bottommost item in place when moving down", () => {
		const items = [item("a"), item("b"), item("c")];
		const result = applyMove(items, "a", "down");
		expect(result.map((i) => i.sourceId)).toEqual(["a", "b", "c"]);
		expect(result).toBe(items);
	});

	it("is a no-op for an unknown sourceId", () => {
		const items = [item("a"), item("b")];
		expect(applyMove(items, "zzz", "up")).toBe(items);
	});

	it("is a no-op on empty or single-item lists", () => {
		expect(applyMove([], "a", "up")).toEqual([]);
		const single = [item("a")];
		expect(applyMove(single, "a", "up")).toBe(single);
		expect(applyMove(single, "a", "down")).toBe(single);
	});

	it("does not mutate the input array", () => {
		const items = [item("a"), item("b")];
		const snapshot = items.map((i) => i.sourceId);
		applyMove(items, "a", "up");
		expect(items.map((i) => i.sourceId)).toEqual(snapshot);
	});
});

describe("defaultItemRect", () => {
	it("gives display sources the full 1920x1080 canvas", () => {
		expect(defaultItemRect("display")).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
	});

	it("centers window/browser sources at 1280x720", () => {
		expect(defaultItemRect("window")).toEqual({ x: 320, y: 180, width: 1280, height: 720 });
		expect(defaultItemRect("browser")).toEqual({ x: 320, y: 180, width: 1280, height: 720 });
	});

	it("also centers audio sources at 1280x720", () => {
		expect(defaultItemRect("audio-input")).toEqual({
			x: 320,
			y: 180,
			width: 1280,
			height: 720,
		});
	});
});
