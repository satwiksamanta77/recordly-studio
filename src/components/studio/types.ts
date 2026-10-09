/**
 * Local renderer-side type definitions for the Recordly Studio module.
 * These mirror the main-process studio types; kept local so the renderer
 * stays decoupled from `electron/` sources.
 */

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;

export type SourceKind = "display" | "window" | "browser" | "audio-input";

export interface StudioSource {
	id: string;
	kind: SourceKind;
	name: string;
	/** display source: Electron display id */
	displayId?: number;
	/** window source: desktopCapturer source id */
	windowId?: string;
	/** window source: exact window title (fallback for gdigrab) */
	windowTitle?: string;
	/** window source: native hwnd hex string */
	hwnd?: string;
	/** display source: desktopCapturer source id */
	captureId?: string | null;
	/** browser source: page URL */
	url?: string;
	/** audio-input source: device name */
	deviceName?: string;
}

export interface SceneItem {
	sourceId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	visible: boolean;
}

export interface StudioScene {
	items: SceneItem[];
}

export type StreamService = "youtube" | "youtube-rtmps" | "twitch" | "facebook" | "custom";

export interface StreamSettings {
	service: StreamService;
	server: string;
	key: string;
}

export const SERVICE_PRESETS: Record<StreamService, { label: string; server: string }> = {
	youtube: { label: "YouTube", server: "rtmp://a.rtmp.youtube.com/live2/" },
	"youtube-rtmps": { label: "YouTube (RTMPS)", server: "rtmps://a.rtmp.youtube.com/live2/" },
	twitch: { label: "Twitch", server: "rtmp://live.twitch.tv/app/" },
	facebook: { label: "Facebook Live", server: "rtmps://live-api-s.facebook.com:443/rtmp/" },
	custom: { label: "Custom", server: "" },
};

export interface DisplayInfo {
	id: number;
	captureId: string | null;
	x: number;
	y: number;
	width: number;
	height: number;
	label: string;
}

export interface WindowInfo {
	id: string;
	name: string;
}

export interface AudioDeviceInfo {
	name: string;
}

export type StudioRunState = "idle" | "running" | "reconnecting" | "error";

export type StudioMode = "record" | "stream" | "record+stream";

export interface StudioRuntimeState {
	state: StudioRunState;
	mode: StudioMode | null;
	recordPath: string | null;
	startedAt: number | null;
	error: string | null;
}

export interface StudioStartOpts {
	scene: StudioScene;
	sources: StudioSource[];
	record: boolean;
	recordPath?: string;
	stream: boolean;
	streamSettings?: StreamSettings;
}

/**
 * Renderer-side view of the `studio*` preload API (added by the main-process
 * module). Accessed through `getStudioApi()` with optional chaining so the
 * UI degrades gracefully if the preload surface is unavailable.
 */
export interface StudioPreloadApi {
	studioOpenWindow(): Promise<{ success: boolean }>;
	studioOpenGoLiveWindow(): Promise<{ success: boolean }>;
	studioGetDisplays(): Promise<DisplayInfo[]>;
	studioGetWindows(): Promise<WindowInfo[]>;
	studioGetAudioDevices(): Promise<AudioDeviceInfo[]>;
	studioStart(opts: StudioStartOpts): Promise<{ success: boolean; error?: string }>;
	studioStop(): Promise<{ success: boolean; error?: string }>;
	studioGetState(): Promise<StudioRuntimeState>;
	studioOnStateChanged(cb: (s: unknown) => void): () => void;
	studioSettingsGet(key: string): Promise<unknown>;
	studioSettingsSet(key: string, value: unknown): Promise<unknown>;
	studioSecretGet(key: string): Promise<string | null>;
	studioSecretSet(key: string, value: string): Promise<unknown>;
	studioSecretDelete(key: string): Promise<unknown>;
	studioYouTubeConnect(opts: { clientId: string; clientSecret?: string }): Promise<{
		success: boolean;
		channelTitle?: string;
		error?: string;
	}>;
	studioYouTubeDisconnect(): Promise<unknown>;
	studioYouTubeStatus(): Promise<{ connected: boolean; channelTitle?: string }>;
	studioYouTubeSetupLive(opts: {
		title: string;
		description?: string;
		privacyStatus: "public" | "unlisted" | "private";
	}): Promise<{
		success: boolean;
		broadcastId?: string;
		ingestionAddress?: string;
		streamName?: string;
		error?: string;
	}>;
	studioYouTubeTransition(opts: {
		broadcastId: string;
		broadcastStatus: "live" | "complete";
	}): Promise<{ success: boolean; error?: string }>;
}

/**
 * Returns the studio preload API guarded with optional chaining.
 * Casts through `unknown` so this module compiles regardless of whether the
 * shared `Window.electronAPI` typings already include the studio methods.
 */
export function getStudioApi(): Partial<StudioPreloadApi> | undefined {
	const w = window as unknown as { electronAPI?: Partial<StudioPreloadApi> };
	return w.electronAPI;
}
