import { spawnSync } from "node:child_process";
import { desktopCapturer, ipcMain, screen } from "electron";
import { readAppSetting, writeAppSetting } from "../../appSettingsStore";
import {
	deleteSecureSetting,
	readSecureSetting,
	writeSecureSetting,
} from "../../secureSettingsStore";
import {
	destroyBrowserSourceOverlays,
	syncBrowserSourceOverlays,
} from "../../studio/browserSources";
import type { MaskRect } from "../../studio/maskServer";
import { createMaskServer } from "../../studio/maskServer";
import { startOcclusionTracker } from "../../studio/occlusion";
import type { PipelineDisplayInfo } from "../../studio/pipeline";
import { buildStudioFfmpegArgs } from "../../studio/pipeline";
import { createStudioSupervisor } from "../../studio/supervisor";
import type {
	StreamSettings,
	StudioRunState,
	StudioScene,
	StudioSessionMode,
	StudioSource,
	StudioStateInfo,
} from "../../studio/types";
import { getStudioWindow } from "../../studio/windowRef";
import {
	connectYouTubeAccount,
	disconnectYouTubeAccount,
	getYouTubeStatus,
} from "../../studio/youtube";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";

type StudioSupervisor = ReturnType<typeof createStudioSupervisor>;
type StudioMaskServer = Awaited<ReturnType<typeof createMaskServer>>;
type StudioOcclusionTracker = ReturnType<typeof startOcclusionTracker>;

export interface StudioStartOptions {
	scene: StudioScene;
	sources: StudioSource[];
	record: boolean;
	recordPath?: string;
	stream: boolean;
	streamSettings?: StreamSettings;
}

let studioSupervisor: StudioSupervisor | null = null;
let studioMaskServer: StudioMaskServer | null = null;
let studioOcclusionTracker: StudioOcclusionTracker | null = null;

let studioState: StudioStateInfo = {
	state: "idle",
	mode: null,
	recordPath: null,
	startedAt: null,
	error: null,
};

function setStudioState(patch: Partial<StudioStateInfo>): void {
	studioState = { ...studioState, ...patch };
	emitStudioState();
}

function emitStudioState(): void {
	const win = getStudioWindow();
	if (!win) {
		return;
	}
	try {
		if (!win.webContents.isDestroyed()) {
			win.webContents.send("studio-state-changed", { ...studioState });
		}
	} catch (error) {
		console.warn("[studio] failed to emit state change:", error);
	}
}

/** Join an RTMP server URL and stream key, tolerating trailing slashes. */
export function buildRtmpUrl(server: string, key: string): string {
	return `${server.replace(/\/+$/, "")}/${key}`;
}

/**
 * Parse `ffmpeg -list_devices true -f dshow -i dummy` stderr into the
 * DirectShow *audio* device names. Only lines after the
 * "DirectShow audio devices" header count; `"Alternative name" ...` lines are
 * skipped.
 */
export function parseDshowAudioDevices(stderrText: string): { name: string }[] {
	const devices: { name: string }[] = [];
	const lines = stderrText.split(/\r?\n/);
	const headerIndex = lines.findIndex((line) => line.includes("DirectShow audio devices"));
	if (headerIndex === -1) {
		return devices;
	}
	for (let i = headerIndex + 1; i < lines.length; i++) {
		// Strip the "[dshow @ ...] " log prefix before inspecting the content.
		const content = lines[i].replace(/^\[[^\]]*\]\s*/, "").trim();
		if (content.length === 0) {
			continue;
		}
		if (content.startsWith('"')) {
			const match = /^"([^"]+)"/.exec(content);
			if (match) {
				devices.push({ name: match[1] });
			}
			continue;
		}
		if (/^alternative name/i.test(content)) {
			continue;
		}
		break;
	}
	return devices;
}

async function teardownStudioResources(): Promise<void> {
	const supervisor = studioSupervisor;
	studioSupervisor = null;
	if (supervisor) {
		try {
			await supervisor.stop();
		} catch (error) {
			console.warn("[studio] supervisor stop failed:", error);
		}
	}

	destroyBrowserSourceOverlays();

	const tracker = studioOcclusionTracker;
	studioOcclusionTracker = null;
	if (tracker) {
		try {
			tracker.stop();
		} catch (error) {
			console.warn("[studio] occlusion tracker stop failed:", error);
		}
	}

	const maskServer = studioMaskServer;
	studioMaskServer = null;
	if (maskServer) {
		try {
			await maskServer.close();
		} catch (error) {
			console.warn("[studio] mask server close failed:", error);
		}
	}
}

/** Best-effort stop of any running studio session (also used on window close). */
export async function stopStudioSession(): Promise<void> {
	await teardownStudioResources();
	setStudioState({
		state: "idle",
		mode: null,
		recordPath: null,
		startedAt: null,
		error: null,
	});
}

async function startStudioSession(options: StudioStartOptions): Promise<{ success: true }> {
	const opts = options ?? ({} as StudioStartOptions);
	const { scene, sources } = opts;
	const record = opts.record === true;
	const stream = opts.stream === true;
	const recordPath = opts.recordPath;
	const streamSettings = opts.streamSettings;

	if (studioSupervisor?.isRunning()) {
		throw new Error("A studio session is already running. Stop it before starting a new one.");
	}
	if (!scene || !Array.isArray(scene.items)) {
		throw new Error("studio-start: a scene with an items array is required.");
	}
	if (!Array.isArray(sources)) {
		throw new Error("studio-start: a sources array is required.");
	}
	if (!record && !stream) {
		throw new Error("studio-start: enable recording and/or streaming.");
	}
	if (record && (typeof recordPath !== "string" || recordPath.length === 0)) {
		throw new Error("studio-start: recordPath is required when recording is enabled.");
	}
	let rtmpUrl: string | undefined;
	if (stream) {
		const server = streamSettings?.server?.trim();
		const key = streamSettings?.key?.trim();
		if (!server || !key) {
			throw new Error(
				"studio-start: stream server and stream key are required when streaming is enabled.",
			);
		}
		rtmpUrl = buildRtmpUrl(server, key);
	}

	const mode: StudioSessionMode =
		record && stream ? "record+stream" : record ? "record" : "stream";

	// Browser overlays must exist (and be painting) before ffmpeg grabs them by title.
	syncBrowserSourceOverlays(sources, scene.items);

	try {
		const sourceById = new Map(sources.map((s) => [s.id, s]));
		const visibleWindowHwnds = scene.items
			.filter((item) => item.visible)
			.map((item) => sourceById.get(item.sourceId))
			.filter(
				(s): s is StudioSource =>
					!!s && s.kind === "window" && typeof s.hwnd === "string" && s.hwnd.length > 0,
			)
			.map((s) => s.hwnd as string);

		// Window-capture isolation (DESIGN.md §3): when a window source is visible,
		// serve an occlusion mask and track occluders so covered regions go black.
		let maskUrl: string | null = null;
		if (visibleWindowHwnds.length > 0) {
			const maskServer = await createMaskServer();
			studioMaskServer = maskServer;
			maskUrl = maskServer.url;
			studioOcclusionTracker = startOcclusionTracker({
				hwnds: visibleWindowHwnds,
				getSceneItems: () => scene.items,
				getSource: (id) => sourceById.get(id),
				onMaskRects: (rects: MaskRect[]) => maskServer.setRects(rects),
				onWarning: (msg) => console.warn("[studio] occlusion:", msg),
			});
		}

		const displays: PipelineDisplayInfo[] = screen.getAllDisplays().map((d) => ({
			id: d.id,
			x: d.bounds.x,
			y: d.bounds.y,
			width: d.bounds.width,
			height: d.bounds.height,
		}));

		const { args } = buildStudioFfmpegArgs(scene, sources, {
			record,
			recordPath,
			stream,
			rtmpUrl,
			maskUrl,
			displays,
		});

		const supervisor = createStudioSupervisor({
			onStateChange: (state: StudioRunState, detail?: string) => {
				setStudioState({ state, error: detail ?? null });
			},
			onUnexpectedExit: (info) => {
				// Record mode: keep it simple — surface the error. The renderer
				// may call studio-start again with a fresh recordPath to start a
				// new segment.
				const tailLine = info.stderrTail
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
					.pop();
				setStudioState({
					state: "error",
					error: tailLine
						? `ffmpeg exited unexpectedly: ${tailLine}`
						: "ffmpeg exited unexpectedly.",
				});
			},
			onRestartNeeded: () => {
				// Streaming reconnect: the main process stays stateless — the
				// renderer re-invokes studio-start to reconnect.
				setStudioState({ state: "reconnecting" });
			},
		});
		studioSupervisor = supervisor;
		supervisor.start(args, mode);

		setStudioState({
			state: "running",
			mode,
			recordPath: record ? (recordPath as string) : null,
			startedAt: Date.now(),
			error: null,
		});
		return { success: true as const };
	} catch (error) {
		await teardownStudioResources();
		throw error;
	}
}

function assertStudioSettingKey(key: unknown): asserts key is string {
	if (typeof key !== "string" || !key.startsWith("studio.")) {
		throw new Error('Only keys starting with "studio." are allowed.');
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerStudioHandlers() {
	ipcMain.handle("studio-get-displays", async () => {
		const displays = screen.getAllDisplays();
		let captureSources: Electron.DesktopCapturerSource[] = [];
		try {
			captureSources = await desktopCapturer.getSources({ types: ["screen"] });
		} catch (error) {
			console.warn("[studio] desktopCapturer.getSources(screen) failed:", error);
		}
		return displays.map((display, index) => {
			const match = captureSources.find(
				(source) => String(source.display_id) === String(display.id),
			);
			return {
				id: display.id,
				captureId: match ? match.id : null,
				x: display.bounds.x,
				y: display.bounds.y,
				width: display.bounds.width,
				height: display.bounds.height,
				label: display.label || `Display ${index + 1}`,
			};
		});
	});

	ipcMain.handle("studio-get-windows", async () => {
		try {
			const sources = await desktopCapturer.getSources({ types: ["window"] });
			return sources
				.filter(
					(source) =>
						source.name &&
						source.name.trim().length > 0 &&
						!source.name.startsWith("RecordlyBrowser-"),
				)
				.map((source) => ({ id: source.id, name: source.name }));
		} catch (error) {
			console.warn("[studio] desktopCapturer.getSources(window) failed:", error);
			return [];
		}
	});

	ipcMain.handle("studio-get-audio-devices", () => {
		if (process.platform !== "win32") {
			return [];
		}
		try {
			const ffmpeg = getFfmpegBinaryPath();
			const result = spawnSync(
				ffmpeg,
				["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
				{ encoding: "utf-8", windowsHide: true, timeout: 15000 },
			);
			const stderr = typeof result.stderr === "string" ? result.stderr : "";
			return parseDshowAudioDevices(stderr);
		} catch (error) {
			console.warn("[studio] failed to list DirectShow audio devices:", error);
			return [];
		}
	});

	ipcMain.handle("studio-start", async (_event, options: StudioStartOptions) => {
		try {
			return await startStudioSession(options);
		} catch (error) {
			const message = toErrorMessage(error);
			setStudioState({ state: "error", error: message });
			return { success: false, error: message };
		}
	});

	ipcMain.handle("studio-stop", async () => {
		try {
			await stopStudioSession();
			return { success: true };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle("studio-get-state", () => {
		return { ...studioState };
	});

	ipcMain.handle("studio-settings-get", (_event, key: unknown) => {
		try {
			assertStudioSettingKey(key);
			return { success: true, value: readAppSetting(key) };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle("studio-settings-set", (_event, key: unknown, value: unknown) => {
		try {
			assertStudioSettingKey(key);
			writeAppSetting(key, value);
			return { success: true };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle("studio-secret-get", async (_event, key: unknown) => {
		try {
			assertStudioSettingKey(key);
			return { success: true, value: await readSecureSetting(key) };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle("studio-secret-set", async (_event, key: unknown, value: unknown) => {
		try {
			assertStudioSettingKey(key);
			if (typeof value !== "string") {
				throw new Error("studio-secret-set: value must be a string.");
			}
			await writeSecureSetting(key, value);
			return { success: true };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle("studio-secret-delete", async (_event, key: unknown) => {
		try {
			assertStudioSettingKey(key);
			await deleteSecureSetting(key);
			return { success: true };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle(
		"studio-youtube-connect",
		async (_event, options: { clientId?: string; clientSecret?: string }) => {
			try {
				const result = await connectYouTubeAccount({
					clientId: options?.clientId ?? "",
					clientSecret: options?.clientSecret ?? "",
				});
				return {
					success: true,
					channelTitle: result.channelTitle,
					ingestionAddress: result.ingestionAddress,
					streamName: result.streamName,
				};
			} catch (error) {
				return { success: false, error: toErrorMessage(error) };
			}
		},
	);

	ipcMain.handle("studio-youtube-disconnect", async () => {
		try {
			await disconnectYouTubeAccount();
			return { success: true };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle("studio-youtube-status", async () => {
		try {
			const status = await getYouTubeStatus();
			return { success: true, ...status };
		} catch (error) {
			return { success: false, error: toErrorMessage(error) };
		}
	});
}
