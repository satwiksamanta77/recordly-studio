import { describe, expect, it } from "vitest";
import type { BuildPipelineOptions } from "./pipeline";
import { buildStudioFfmpegArgs } from "./pipeline";
import type { SceneItem, StudioScene, StudioSource } from "./types";

function displaySource(id = "disp1", displayId = 0): StudioSource {
	return { id, kind: "display", name: "Display 1", displayId };
}

function windowSource(id = "win1", windowTitle?: string, hwnd?: string): StudioSource {
	return { id, kind: "window", name: "Window", windowTitle, hwnd };
}

function browserSource(id = "br1"): StudioSource {
	return { id, kind: "browser", name: "Browser" };
}

function audioSource(id = "mic1", deviceName = "Microphone"): StudioSource {
	return { id, kind: "audio-input", name: "Mic", deviceName };
}

function item(
	sourceId: string,
	x = 0,
	y = 0,
	width = 1920,
	height = 1080,
	visible = true,
): SceneItem {
	return { sourceId, x, y, width, height, visible };
}

const DISPLAYS = [{ id: 0, x: 0, y: 0, width: 1920, height: 1080 }];

function baseOpts(overrides: Partial<BuildPipelineOptions> = {}): BuildPipelineOptions {
	return {
		record: true,
		recordPath: "out.mp4",
		stream: false,
		displays: DISPLAYS,
		...overrides,
	};
}

function inputArgsOf(scene: StudioScene, sources: StudioSource[], opts: BuildPipelineOptions) {
	const built = buildStudioFfmpegArgs(scene, sources, opts);
	return built.args.slice(2, built.args.indexOf("-filter_complex"));
}

describe("studio ffmpeg pipeline", () => {
	it("starts with global args and ends with -r 60", () => {
		const built = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts(),
		);
		expect(built.args[0]).toBe("-hide_banner");
		expect(built.args[1]).toBe("-y");
		expect(built.args).toContain("-r");
		expect(built.args[built.args.indexOf("-r") + 1]).toBe("60");
		expect(built.args).toContain("-map");
		expect(built.args[built.args.indexOf("-map") + 1]).toBe("[outv]");
	});

	it("builds a display input with video_size and offsets from the display bounds", () => {
		const displays = [
			{ id: 0, x: 0, y: 0, width: 1920, height: 1080 },
			{ id: 1, x: 1920, y: -200, width: 2560, height: 1440 },
		];
		const inputs = inputArgsOf(
			{ items: [item("disp2")] },
			[displaySource("disp2", 1)],
			baseOpts({ displays }),
		);
		expect(inputs).toEqual([
			"-f",
			"gdigrab",
			"-framerate",
			"60",
			"-draw_mouse",
			"1",
			"-video_size",
			"2560x1440",
			"-offset_x",
			"1920",
			"-offset_y",
			"-200",
			"-i",
			"desktop",
		]);
	});

	it("skips a display source whose display is not found", () => {
		const scene: StudioScene = { items: [item("disp1"), item("disp2")] };
		const sources = [displaySource("disp1", 99), displaySource("disp2", 0)];
		const built = buildStudioFfmpegArgs(scene, sources, baseOpts());
		expect(built.videoInputCount).toBe(1);
	});

	it("builds a window input with the escaped title", () => {
		const inputs = inputArgsOf(
			{ items: [item("win1")] },
			[windowSource("win1", 'My "Cool" App')],
			baseOpts(),
		);
		expect(inputs).toEqual([
			"-f",
			"gdigrab",
			"-framerate",
			"60",
			"-i",
			'title="My \\"Cool\\" App"',
		]);
	});

	it("falls back to hwnd when a window source has no title", () => {
		const inputs = inputArgsOf(
			{ items: [item("win1")] },
			[windowSource("win1", undefined, "0x1A2B3C")],
			baseOpts(),
		);
		expect(inputs).toEqual(["-f", "gdigrab", "-framerate", "60", "-i", "hwnd=0x1A2B3C"]);
	});

	it("skips a window source with neither title nor hwnd", () => {
		const scene: StudioScene = { items: [item("win1")] };
		expect(() => buildStudioFfmpegArgs(scene, [windowSource("win1")], baseOpts())).toThrow(
			/no visible.*video sources/i,
		);
	});

	it("builds a browser input with the RecordlyBrowser-<id> title", () => {
		const inputs = inputArgsOf({ items: [item("br1")] }, [browserSource("br1")], baseOpts());
		expect(inputs).toEqual([
			"-f",
			"gdigrab",
			"-framerate",
			"30",
			"-i",
			'title="RecordlyBrowser-br1"',
		]);
	});

	it("appends audio inputs after all video inputs and maps the first one", () => {
		const scene: StudioScene = { items: [item("mic1"), item("disp1")] };
		const sources = [audioSource(), displaySource()];
		const built = buildStudioFfmpegArgs(scene, sources, baseOpts());
		expect(built.hasAudio).toBe(true);
		expect(built.videoInputCount).toBe(1);
		const inputs = built.args.slice(2, built.args.indexOf("-filter_complex"));
		expect(inputs).toEqual([
			"-f",
			"gdigrab",
			"-framerate",
			"60",
			"-draw_mouse",
			"1",
			"-video_size",
			"1920x1080",
			"-offset_x",
			"0",
			"-offset_y",
			"0",
			"-i",
			"desktop",
			"-f",
			"dshow",
			"-i",
			'audio="Microphone"',
		]);
		const mapIdx = built.args.indexOf("-map");
		expect(built.args.slice(mapIdx, mapIdx + 4)).toEqual(["-map", "[outv]", "-map", "1:a"]);
		for (const flag of ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]) {
			expect(built.args).toContain(flag);
		}
	});

	it("skips invisible items and unresolvable sources", () => {
		const scene: StudioScene = {
			items: [item("disp1", 0, 0, 1920, 1080, false), item("ghost"), item("disp2")],
		};
		const sources = [displaySource("disp1"), displaySource("disp2")];
		const built = buildStudioFfmpegArgs(scene, sources, baseOpts());
		expect(built.videoInputCount).toBe(1);
	});

	it("chains overlays in z-order for three sources", () => {
		const scene: StudioScene = {
			items: [
				item("disp1", 0, 0, 1920, 1080),
				item("win1", 10, 20, 640, 480),
				item("br1", 30, 40, 800, 600),
			],
		};
		const sources = [displaySource(), windowSource("win1", "App"), browserSource()];
		const built = buildStudioFfmpegArgs(scene, sources, baseOpts());
		expect(built.videoInputCount).toBe(3);
		expect(
			built.filterGraph.startsWith(
				"[0:v]setpts=PTS-STARTPTS,scale=1920:1080,setsar=1[base];",
			),
		).toBe(true);
		expect(built.filterGraph).toContain(
			"[base][s1]overlay=10:20:format=yuv420[t1];[t1][s2]overlay=30:40:format=yuv420[t2]",
		);
		expect(built.filterGraph).toContain("[1:v]setpts=PTS-STARTPTS,scale=640:480[s1]");
		expect(built.filterGraph).toContain("[2:v]setpts=PTS-STARTPTS,scale=800:600[s2]");
		expect(built.filterGraph.endsWith("[t2]format=yuv420p[outv]")).toBe(true);
	});

	it("uses the simple single-source graph", () => {
		const built = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts(),
		);
		expect(built.filterGraph).toBe(
			"[0:v]setpts=PTS-STARTPTS,scale=1920:1080,setsar=1,format=yuv420p[outv]",
		);
	});

	it("adds the mask input only when window sources exist AND maskUrl is given", () => {
		const maskUrl = "http://127.0.0.1:5123/mask.raw";
		const scene: StudioScene = { items: [item("win1")] };
		const sources = [windowSource("win1", "App")];

		const withMask = buildStudioFfmpegArgs(scene, sources, baseOpts({ maskUrl }));
		expect(withMask.maskNeeded).toBe(true);
		const inputs = withMask.args.slice(2, withMask.args.indexOf("-filter_complex"));
		expect(inputs).toEqual([
			"-f",
			"gdigrab",
			"-framerate",
			"60",
			"-i",
			'title="App"',
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			"-video_size",
			"1920x1080",
			"-framerate",
			"5",
			"-use_wallclock_as_timestamps",
			"1",
			"-i",
			maskUrl,
		]);
		expect(withMask.filterGraph).toBe(
			"[0:v]setpts=PTS-STARTPTS,scale=1920:1080,setsar=1[base];" +
				"[base][1:v]overlay=0:0:format=yuv420,format=yuv420p[outv]",
		);

		const noMaskUrl = buildStudioFfmpegArgs(scene, sources, baseOpts());
		expect(noMaskUrl.maskNeeded).toBe(false);
		expect(noMaskUrl.args).not.toContain("rawvideo");
		expect(noMaskUrl.filterGraph).not.toContain("overlay=0:0");

		const displayOnly = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts({ maskUrl }),
		);
		expect(displayOnly.maskNeeded).toBe(false);
		expect(displayOnly.args).not.toContain("rawvideo");
	});

	it("overlay the mask after the last composited frame in multi-source scenes", () => {
		const scene: StudioScene = {
			items: [item("disp1", 0, 0, 1920, 1080), item("win1", 10, 20, 640, 480)],
		};
		const sources = [displaySource(), windowSource("win1", "App")];
		const built = buildStudioFfmpegArgs(
			scene,
			sources,
			baseOpts({ maskUrl: "http://127.0.0.1:5123/mask.raw" }),
		);
		expect(built.maskNeeded).toBe(true);
		expect(built.filterGraph).toContain(
			"[t1][2:v]overlay=0:0:format=yuv420,format=yuv420p[outv]",
		);
	});

	it("uses CBR streaming flags when streaming", () => {
		const built = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts({ record: false, stream: true, rtmpUrl: "rtmp://live.example.com/app/key" }),
		);
		for (const flag of [
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
		]) {
			expect(built.args).toContain(flag);
		}
		expect(built.args).not.toContain("-crf");
		const outIdx = built.args.lastIndexOf("-f");
		expect(built.args.slice(outIdx)).toEqual(["-f", "flv", "rtmp://live.example.com/app/key"]);
	});

	it("disables TLS peer verification for RTMPS stream-only output (OBS parity)", () => {
		const built = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts({
				record: false,
				stream: true,
				rtmpUrl: "rtmps://a.rtmps.youtube.com:443/live2/key",
			}),
		);
		const outIdx = built.args.lastIndexOf("-f");
		expect(built.args.slice(outIdx - 2)).toEqual([
			"-tls_verify",
			"0",
			"-f",
			"flv",
			"rtmps://a.rtmps.youtube.com:443/live2/key",
		]);
	});

	it("keeps strict TLS verification for plain rtmp stream-only output", () => {
		const built = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts({ record: false, stream: true, rtmpUrl: "rtmp://live.example.com/app/key" }),
		);
		expect(built.args).not.toContain("-tls_verify");
	});

	it("uses CRF recording flags when recording only", () => {
		const built = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts({ recordPath: "out.mp4" }),
		);
		expect(built.args).toContain("-crf");
		expect(built.args[built.args.indexOf("-crf") + 1]).toBe("20");
		expect(built.args).not.toContain("-b:v");
		const outIdx = built.args.lastIndexOf("-f");
		expect(built.args.slice(outIdx)).toEqual([
			"-f",
			"mp4",
			"-movflags",
			"+faststart",
			"out.mp4",
		]);
	});

	it("uses the streaming encode for record+stream and emits a tee output", () => {
		const built = buildStudioFfmpegArgs(
			{ items: [item("disp1")] },
			[displaySource()],
			baseOpts({
				recordPath: "C:\\Videos\\out.mp4",
				stream: true,
				rtmpUrl: "rtmp://live.example.com/app/secret-key",
			}),
		);
		expect(built.args).toContain("-b:v");
		expect(built.args).not.toContain("-crf");
		const outIdx = built.args.lastIndexOf("-f");
		expect(built.args[outIdx + 1]).toBe("tee");
		const teeValue = built.args[outIdx + 2];
		expect(teeValue).toBe(
			"[f=mp4:movflags=+faststart]C\\:\\\\Videos\\\\out.mp4|[f=flv]rtmp://live.example.com/app/secret-key",
		);
		// The Windows drive colon and backslashes are tee-escaped...
		expect(teeValue).toContain("\\:");
		expect(teeValue).toContain("\\\\");
		// ...while the RTMP URL is left untouched.
		expect(teeValue).toContain("|[f=flv]rtmp://live.example.com/app/secret-key");
	});

	it("throws descriptive errors for invalid configs", () => {
		const scene: StudioScene = { items: [item("disp1")] };
		const sources = [displaySource()];
		expect(() => buildStudioFfmpegArgs({ items: [] }, [], baseOpts())).toThrow(
			/no visible.*video sources/i,
		);
		expect(() =>
			buildStudioFfmpegArgs(scene, sources, baseOpts({ recordPath: undefined })),
		).toThrow(/recordPath/);
		expect(() =>
			buildStudioFfmpegArgs(
				scene,
				sources,
				baseOpts({ record: false, stream: true, rtmpUrl: undefined }),
			),
		).toThrow(/rtmpUrl/);
		expect(() => buildStudioFfmpegArgs(scene, sources, baseOpts({ record: false }))).toThrow(
			/record or stream/i,
		);
	});
});
