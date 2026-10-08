import { CANVAS_HEIGHT, CANVAS_WIDTH, type SceneItem, type SourceKind } from "./types";

/**
 * Z-order helpers for the scene item list. The list is bottom-to-top:
 * index 0 is the bottom-most layer, the last index renders on top.
 * "up" moves an item one layer towards the top (higher z).
 */

/** Reorder `items` moving the item for `sourceId` one step `dir`. Pure. */
export function applyMove(items: SceneItem[], sourceId: string, dir: "up" | "down"): SceneItem[] {
	const idx = items.findIndex((item) => item.sourceId === sourceId);
	if (idx < 0) return items;
	const target = dir === "up" ? idx + 1 : idx - 1;
	if (target < 0 || target >= items.length) return items;
	const next = items.slice();
	const [moved] = next.splice(idx, 1);
	next.splice(target, 0, moved);
	return next;
}

/** Default scene-item rect for a newly added source. */
export function defaultItemRect(kind: SourceKind): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	if (kind === "display") {
		return { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
	}
	// window / browser / audio: centered 1280x720 on the 1920x1080 canvas
	const width = 1280;
	const height = 720;
	return {
		x: Math.round((CANVAS_WIDTH - width) / 2),
		y: Math.round((CANVAS_HEIGHT - height) / 2),
		width,
		height,
	};
}
