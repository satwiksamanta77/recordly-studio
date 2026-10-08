export const STUDIO_CANVAS_WIDTH = 1920;
export const STUDIO_CANVAS_HEIGHT = 1080;
export const STUDIO_FPS = 60;

export type StudioSourceKind = "display" | "window" | "browser" | "audio-input";

export interface StudioSource {
	id: string;
	kind: StudioSourceKind;
	name: string;
	displayId?: number;
	windowId?: string;
	windowTitle?: string;
	hwnd?: string;
	url?: string;
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

export type StudioSessionMode = "record" | "stream" | "record+stream";

export type StudioRunState = "idle" | "running" | "reconnecting" | "error";

export interface StudioStateInfo {
	state: StudioRunState;
	mode: StudioSessionMode | null;
	recordPath: string | null;
	startedAt: number | null;
	error: string | null;
}
