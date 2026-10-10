import type { SceneItem, StudioScene, StudioSource } from "./types";
import { STUDIO_CANVAS_HEIGHT, STUDIO_CANVAS_WIDTH, STUDIO_FPS } from "./types";

export interface PipelineDisplayInfo {
	id: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BuildPipelineOptions {
	record: boolean;
	recordPath?: string;
	stream: boolean;
	rtmpUrl?: string;
	maskUrl?: string | null;
	displays: PipelineDisplayInfo[];
}

export interface BuiltPipeline {
	/** Spawn-ready argv (no shell quoting): pass directly to child_process.spawn. */
	args: string[];
	filterGraph: string;
	maskNeeded: boolean;
	videoInputCount: number;
	hasAudio: boolean;
}

interface ResolvedVideoInput {
	source: StudioSource;
	item: SceneItem;
	inputArgs: string[];
}

interface ResolvedAudioInput {
	source: StudioSource;
	inputArgs: string[];
}

/**
 * Backslash-escape the characters the tee muxer treats as syntax in its value
 * (`\`, `:`, `|`, `'`). Required so Windows paths like `C:\Videos\out.mp4`
 * survive inside `[f=mp4:...]C\:\...|[f=flv]...`.
 */
function escapeTeeValue(value: string): string {
	return value.replace(/([\\:|'])/g, "\\$1");
}

/** Escape double quotes inside a gdigrab `title="..."` input value. */
function escapeWindowTitle(title: string): string {
	return title.replace(/"/g, '\\"');
}

function buildDisplayInputArgs(
	source: StudioSource,
	displays: PipelineDisplayInfo[],
): string[] | null {
	const display = displays.find((d) => d.id === source.displayId);
	if (!display) {
		return null;
	}
	return [
		"-f",
		"gdigrab",
		"-framerate",
		String(STUDIO_FPS),
		"-draw_mouse",
		"1",
		"-video_size",
		`${display.width}x${display.height}`,
		"-offset_x",
		String(display.x),
		"-offset_y",
		String(display.y),
		"-i",
		"desktop",
	];
}

function buildWindowInputArgs(source: StudioSource): string[] | null {
	if (source.windowTitle) {
		return [
			"-f",
			"gdigrab",
			"-framerate",
			String(STUDIO_FPS),
			"-i",
			`title="${escapeWindowTitle(source.windowTitle)}"`,
		];
	}
	if (source.hwnd) {
		return ["-f", "gdigrab", "-framerate", String(STUDIO_FPS), "-i", `hwnd=${source.hwnd}`];
	}
	return null;
}

function buildBrowserInputArgs(source: StudioSource): string[] {
	// Matches the hidden overlay window title the main process assigns
	// (`RecordlyBrowser-<id>`, created off-screen at -10000,-10000).
	return ["-f", "gdigrab", "-framerate", "30", "-i", `title="RecordlyBrowser-${source.id}"`];
}

function buildAudioInputArgs(source: StudioSource): string[] | null {
	if (!source.deviceName) {
		return null;
	}
	return ["-f", "dshow", "-i", `audio="${source.deviceName}"`];
}

function buildVideoInputArgs(
	source: StudioSource,
	displays: PipelineDisplayInfo[],
): string[] | null {
	switch (source.kind) {
		case "display":
			return buildDisplayInputArgs(source, displays);
		case "window":
			return buildWindowInputArgs(source);
		case "browser":
			return buildBrowserInputArgs(source);
		case "audio-input":
			return null;
	}
}

export function buildStudioFfmpegArgs(
	scene: StudioScene,
	sources: StudioSource[],
	opts: BuildPipelineOptions,
): BuiltPipeline {
	if (!opts.record && !opts.stream) {
		throw new Error("buildStudioFfmpegArgs: at least one of record or stream must be enabled");
	}
	if (opts.record && !opts.recordPath) {
		throw new Error("buildStudioFfmpegArgs: record is enabled but no recordPath was provided");
	}
	if (opts.stream && !opts.rtmpUrl) {
		throw new Error("buildStudioFfmpegArgs: stream is enabled but no rtmpUrl was provided");
	}
	const recordPath = opts.recordPath as string;
	const rtmpUrl = opts.rtmpUrl as string;

	const sourceById = new Map(sources.map((s) => [s.id, s]));

	// Resolve scene items in z-order, skipping invisible items and sources that
	// cannot be turned into an ffmpeg input (unknown id, unknown display, window
	// with neither title nor hwnd, audio without a device name).
	// Video inputs keep z-order; audio inputs are appended after ALL video inputs
	// so video input indices stay dense and stable for the filter graph.
	const videoInputs: ResolvedVideoInput[] = [];
	const audioInputs: ResolvedAudioInput[] = [];
	for (const item of scene.items) {
		if (!item.visible) {
			continue;
		}
		const source = sourceById.get(item.sourceId);
		if (!source) {
			continue;
		}
		if (source.kind === "audio-input") {
			const inputArgs = buildAudioInputArgs(source);
			if (inputArgs) {
				audioInputs.push({ source, inputArgs });
			}
			continue;
		}
		const inputArgs = buildVideoInputArgs(source, opts.displays);
		if (inputArgs) {
			videoInputs.push({ source, item, inputArgs });
		}
	}
	if (videoInputs.length === 0) {
		throw new Error("buildStudioFfmpegArgs: scene has no visible, resolvable video sources");
	}

	// Occlusion blackout mask: only needed when at least one window source is
	// captured AND the main process is serving the mask stream.
	const maskUrl = opts.maskUrl;
	const hasWindowSource = videoInputs.some((v) => v.source.kind === "window");
	const maskNeeded = hasWindowSource && !!maskUrl;

	const args: string[] = ["-hide_banner", "-y"];
	for (const input of videoInputs) {
		args.push(...input.inputArgs);
	}
	const audioBaseIndex = videoInputs.length;
	for (const input of audioInputs) {
		args.push(...input.inputArgs);
	}
	let maskIndex = -1;
	if (maskNeeded && maskUrl) {
		maskIndex = videoInputs.length + audioInputs.length;
		// Infinite rawvideo mask served over HTTP by the main process (black opaque
		// where window pixels are occluded, transparent elsewhere). use_wallclock_as_
		// timestamps keeps it live without blocking; overlayed at 0:0 it paints
		// occlusions black on the composited canvas. No ffmpeg restart needed.
		args.push(
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			"-video_size",
			`${STUDIO_CANVAS_WIDTH}x${STUDIO_CANVAS_HEIGHT}`,
			"-framerate",
			"5",
			"-use_wallclock_as_timestamps",
			"1",
			"-i",
			maskUrl,
		);
	}

	// Filter graph: input 0 is the full-canvas base; each further source is scaled
	// to its scene rect and overlayed in z-order.
	const canvasScale = `${STUDIO_CANVAS_WIDTH}:${STUDIO_CANVAS_HEIGHT}`;
	let filterGraph: string;
	if (videoInputs.length === 1) {
		if (maskNeeded) {
			filterGraph =
				`[0:v]setpts=PTS-STARTPTS,scale=${canvasScale},setsar=1[base];` +
				`[base][${maskIndex}:v]overlay=0:0:format=yuv420,format=yuv420p[outv]`;
		} else {
			filterGraph = `[0:v]setpts=PTS-STARTPTS,scale=${canvasScale},setsar=1,format=yuv420p[outv]`;
		}
	} else {
		const basePart = `[0:v]setpts=PTS-STARTPTS,scale=${canvasScale},setsar=1[base]`;
		// Scale chains for every overlayed source come first, then the overlay
		// chain itself, so the overlays read as one ordered z-sequence.
		const scaleParts: string[] = [];
		const overlayParts: string[] = [];
		let prev = "base";
		videoInputs.forEach((input, i) => {
			if (i === 0) {
				return;
			}
			scaleParts.push(
				`[${i}:v]setpts=PTS-STARTPTS,scale=${input.item.width}:${input.item.height}[s${i}]`,
			);
			overlayParts.push(
				`[${prev}][s${i}]overlay=${input.item.x}:${input.item.y}:format=yuv420[t${i}]`,
			);
			prev = `t${i}`;
		});
		const parts = [basePart, ...scaleParts, ...overlayParts];
		if (maskNeeded) {
			parts.push(`[${prev}][${maskIndex}:v]overlay=0:0:format=yuv420,format=yuv420p[outv]`);
		} else {
			parts.push(`[${prev}]format=yuv420p[outv]`);
		}
		filterGraph = parts.join(";");
	}

	const hasAudio = audioInputs.length > 0;
	args.push("-filter_complex", filterGraph, "-map", "[outv]");
	if (hasAudio) {
		args.push("-map", `${audioBaseIndex}:a`);
	}
	if (opts.stream) {
		// Streaming (CBR) encode. v1 rule: when record+stream share one encode, the
		// streaming settings are used for both outputs (see DESIGN §2.3).
		args.push(
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-tune",
			"zerolatency",
			"-b:v",
			"6000k",
			"-maxrate",
			"6000k",
			"-bufsize",
			"12000k",
			"-g",
			"120",
			"-keyint_min",
			"120",
			"-profile:v",
			"high",
			"-pix_fmt",
			"yuv420p",
		);
	} else {
		args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
	}
	if (hasAudio) {
		args.push("-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2");
	}
	args.push("-r", String(STUDIO_FPS));

	if (opts.record && opts.stream) {
		// Tee muxer: one encode, two destinations. Args are spawn-ready (no shell),
		// so the tee value must NOT be wrapped in shell quotes — instead the path
		// is escaped for the tee parser (see escapeTeeValue).
		const teeValue =
			`[f=mp4:movflags=+faststart]${escapeTeeValue(recordPath)}` + `|[f=flv]${rtmpUrl}`;
		args.push("-f", "tee", teeValue);
	} else if (opts.record) {
		args.push("-f", "mp4", "-movflags", "+faststart", recordPath);
	} else {
		args.push("-f", "flv", rtmpUrl);
	}

	return {
		args,
		filterGraph,
		maskNeeded,
		videoInputCount: videoInputs.length,
		hasAudio,
	};
}
