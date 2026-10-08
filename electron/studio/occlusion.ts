// win-occlusion.exe protocol:
//   argv:   win-occlusion.exe <hwnd...>              (hex HWND strings, e.g. "0x000A0B0C")
//   stdout: one JSON object per line, emitted at ~5Hz:
//     {"windows":{
//        "0xABC": {"rect": {"x":0,"y":0,"w":800,"h":600},
//                   "minimized": false, "cloaked": false,
//                   "occluded": [{"x":10,"y":10,"w":100,"h":100}]}}}
//   All rects are in screen coordinates. "occluded" lists the portions of the
//   target window covered by other visible, non-minimized windows above it in
//   z-order (own-process windows excluded). The helper only reports windows
//   passed on the command line. A missing "rect" means the helper lost the
//   window; that window is treated as fully visible (no blackout) rather than
//   blacked out blindly.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolvePreferredWindowsNativeHelperPath } from "../ipc/paths/binaries";
import type { MaskRect } from "./maskServer";
import type { SceneItem, StudioSource } from "./types";

export interface ScreenRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OcclusionWindowState {
	rect?: ScreenRect;
	minimized: boolean;
	cloaked: boolean;
	occluded: ScreenRect[];
}

/**
 * Map occluder screen-rects onto the 1920x1080 canvas via the target window's
 * screen rect and its scene-item geometry. Pure: no I/O, no process state.
 *
 * canvasX = item.x + (r.x - windowRect.x) * (item.width / windowRect.w),
 * same for Y. Each rect is clipped to the item's canvas rect; empties are dropped.
 */
export function mapOcclusionToCanvas(
	occluded: ScreenRect[],
	windowRect: ScreenRect,
	item: SceneItem,
): MaskRect[] {
	if (windowRect.w <= 0 || windowRect.h <= 0) {
		return [];
	}
	const scaleX = item.width / windowRect.w;
	const scaleY = item.height / windowRect.h;
	const out: MaskRect[] = [];
	for (const rect of occluded) {
		const x0 = Math.max(item.x, item.x + (rect.x - windowRect.x) * scaleX);
		const y0 = Math.max(item.y, item.y + (rect.y - windowRect.y) * scaleY);
		const x1 = Math.min(item.x + item.width, x0 + rect.w * scaleX);
		const y1 = Math.min(item.y + item.height, y0 + rect.h * scaleY);
		if (x1 <= x0 || y1 <= y0) {
			continue;
		}
		// Clipped to the item's canvas rect per the protocol; the mask server
		// clips again to the 1920x1080 frame at paint time.
		out.push({
			x: Math.round(x0),
			y: Math.round(y0),
			w: Math.round(x1 - x0),
			h: Math.round(y1 - y0),
		});
	}
	return out;
}

/**
 * Packaged-aware path for win-occlusion.exe: same pattern as the other Windows
 * native helpers (e.g. wgc-capture) — prebundled under
 * electron/native/bin/win32-x64/ (asarUnpack-aware), falling back to a local
 * CMake build output in a source checkout.
 */
export function resolveOcclusionExePath(): string {
	return resolvePreferredWindowsNativeHelperPath("win-occlusion", "win-occlusion.exe");
}

export function startOcclusionTracker(opts: {
	hwnds: string[]; // "0x..." hex strings
	getSceneItems: () => SceneItem[];
	getSource: (sourceId: string) => StudioSource | undefined;
	onMaskRects: (rects: MaskRect[]) => void;
	onWarning?: (msg: string) => void;
}): { stop(): void } {
	const warn = (msg: string) => opts.onWarning?.(msg);

	const exePath = resolveOcclusionExePath();
	if (!existsSync(exePath)) {
		// Occlusion blackout is best-effort: window-DC capture already guarantees
		// no foreign pixels; without the helper we simply cannot black out the
		// occluded regions of a window source.
		warn("win-occlusion.exe not found — window-capture blackout disabled");
		return { stop() {} /* no-op: helper was never started */ };
	}

	const child = spawn(exePath, opts.hwnds, { windowsHide: true });
	let stopped = false;
	const warnedNoRect = new Set<string>();

	const stop = () => {
		if (stopped) return;
		stopped = true;
		try {
			child.kill();
		} catch {
			// Already exited.
		}
	};

	const handleReport = (report: { windows?: Record<string, OcclusionWindowState> }) => {
		const items = opts.getSceneItems();
		const rects: MaskRect[] = [];
		for (const [hwnd, state] of Object.entries(report.windows ?? {})) {
			const normalized = hwnd.toLowerCase();
			const item = items.find((candidate) => {
				if (candidate.visible === false) return false;
				const source = opts.getSource(candidate.sourceId);
				return typeof source?.hwnd === "string" && source.hwnd.toLowerCase() === normalized;
			});
			if (!item) continue;
			if (state.minimized || state.cloaked) {
				// Minimized/cloaked windows render nothing; black out the whole item.
				rects.push({ x: item.x, y: item.y, w: item.width, h: item.height });
				continue;
			}
			if (!state.rect) {
				if (!warnedNoRect.has(normalized)) {
					warnedNoRect.add(normalized);
					warn(
						`win-occlusion: no screen rect reported for window ${hwnd}; treating as fully visible`,
					);
				}
				continue;
			}
			rects.push(...mapOcclusionToCanvas(state.occluded ?? [], state.rect, item));
		}
		opts.onMaskRects(rects);
	};

	let pending = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim().length === 0) continue;
			try {
				handleReport(
					JSON.parse(line) as { windows?: Record<string, OcclusionWindowState> },
				);
			} catch {
				warn(`win-occlusion: ignoring malformed JSON line: ${line.slice(0, 120)}`);
			}
		}
	});
	child.on("error", (error) => {
		warn(`win-occlusion helper failed to start: ${error.message}`);
		stop();
	});
	child.on("exit", (code, signal) => {
		warn(`win-occlusion helper exited (code=${code}, signal=${signal}); blackout disabled`);
		stop();
	});

	return { stop };
}
