import type { BrowserWindow } from "electron";

/**
 * Holds the Studio window reference without creating an import cycle:
 * `windows.ts` (window factory) sets it, the studio IPC registrar reads it to
 * emit `studio-state-changed` events.
 */
let studioWindow: BrowserWindow | null = null;
let goLiveWindow: BrowserWindow | null = null;

export function setStudioWindow(win: BrowserWindow | null): void {
	studioWindow = win;
}

export function getStudioWindow(): BrowserWindow | null {
	return studioWindow && !studioWindow.isDestroyed() ? studioWindow : null;
}

export function setGoLiveWindow(win: BrowserWindow | null): void {
	goLiveWindow = win;
}

export function getGoLiveWindow(): BrowserWindow | null {
	return goLiveWindow && !goLiveWindow.isDestroyed() ? goLiveWindow : null;
}
