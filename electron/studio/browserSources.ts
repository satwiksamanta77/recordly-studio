import { BrowserWindow } from "electron";
import type { SceneItem, StudioSource } from "./types";

/**
 * Off-screen overlay windows for browser sources.
 *
 * Each `browser` source gets a hidden BrowserWindow (positioned at -10000,-10000
 * so the user never sees it) titled `RecordlyBrowser-<sourceId>`. The window
 * must be SHOWN to paint; ffmpeg captures it via gdigrab `title=`. Windows are
 * keyed by source id and reused across syncs; stale ones are destroyed.
 */
const browserOverlays = new Map<string, BrowserWindow>();

function getOverlay(sourceId: string): BrowserWindow | undefined {
	const win = browserOverlays.get(sourceId);
	if (win && win.isDestroyed()) {
		browserOverlays.delete(sourceId);
		return undefined;
	}
	return win;
}

export function syncBrowserSourceOverlays(sources: StudioSource[], items: SceneItem[]): void {
	const visibleBySourceId = new Map<string, boolean>();
	for (const item of items) {
		if (item.visible) {
			visibleBySourceId.set(item.sourceId, true);
		} else if (!visibleBySourceId.has(item.sourceId)) {
			visibleBySourceId.set(item.sourceId, false);
		}
	}

	const wantedIds = new Set<string>();
	for (const source of sources) {
		if (source.kind !== "browser") {
			continue;
		}
		wantedIds.add(source.id);

		let win = getOverlay(source.id);
		if (!win) {
			win = new BrowserWindow({
				x: -10000,
				y: -10000,
				width: 1280,
				height: 720,
				show: false,
				skipTaskbar: true,
				title: `RecordlyBrowser-${source.id}`,
				webPreferences: {
					contextIsolation: true,
					nodeIntegration: false,
				},
			});
			browserOverlays.set(source.id, win);
			if (source.url) {
				win.loadURL(source.url).catch((error: unknown) => {
					console.warn(`[studio] browser source ${source.id} failed to load:`, error);
				});
			}
		}

		// The window must be shown to paint; it stays off-screen so it is
		// never visible to the user while gdigrab captures it by title.
		const visible = visibleBySourceId.get(source.id) === true;
		try {
			if (visible) {
				if (!win.isVisible()) {
					win.show();
				}
			} else if (win.isVisible()) {
				win.hide();
			}
		} catch (error) {
			console.warn(`[studio] failed to toggle browser overlay ${source.id}:`, error);
		}
	}

	for (const [id, win] of browserOverlays) {
		if (wantedIds.has(id)) {
			continue;
		}
		browserOverlays.delete(id);
		try {
			if (!win.isDestroyed()) {
				win.destroy();
			}
		} catch (error) {
			console.warn(`[studio] failed to destroy browser overlay ${id}:`, error);
		}
	}
}

export function destroyBrowserSourceOverlays(): void {
	for (const [id, win] of browserOverlays) {
		try {
			if (!win.isDestroyed()) {
				win.destroy();
			}
		} catch (error) {
			console.warn(`[studio] failed to destroy browser overlay ${id}:`, error);
		}
	}
	browserOverlays.clear();
}
