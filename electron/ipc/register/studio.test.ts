import { describe, expect, it, vi } from "vitest";

// The registrar pulls in Electron main-process modules (appSettingsStore reads
// app.getPath at load; sibling studio modules are owned by other workers).
// Mock them so the pure helpers under test load in the node test env.
vi.mock("../../appSettingsStore", () => ({
	readAppSetting: vi.fn(),
	writeAppSetting: vi.fn(),
}));
vi.mock("../../secureSettingsStore", () => ({
	readSecureSetting: vi.fn(),
	writeSecureSetting: vi.fn(),
	deleteSecureSetting: vi.fn(),
}));
vi.mock("../../studio/pipeline", () => ({
	buildStudioFfmpegArgs: vi.fn(),
}));
vi.mock("../../studio/supervisor", () => ({
	createStudioSupervisor: vi.fn(),
	getReconnectDelayMs: vi.fn(),
}));
vi.mock("../../studio/maskServer", () => ({
	createMaskServer: vi.fn(),
}));
vi.mock("../../studio/occlusion", () => ({
	startOcclusionTracker: vi.fn(),
	mapOcclusionToCanvas: vi.fn(),
	resolveOcclusionExePath: vi.fn(),
}));
vi.mock("../../studio/youtube", () => ({
	connectYouTubeAccount: vi.fn(),
	disconnectYouTubeAccount: vi.fn(),
	getYouTubeStatus: vi.fn(),
}));

import { buildRtmpUrl, parseDshowAudioDevices } from "./studio";

describe("buildRtmpUrl", () => {
	it("joins server and key with a single slash", () => {
		expect(buildRtmpUrl("rtmp://a.rtmp.youtube.com/live", "abcd-efgh")).toBe(
			"rtmp://a.rtmp.youtube.com/live/abcd-efgh",
		);
	});

	it("strips trailing slashes from the server", () => {
		expect(buildRtmpUrl("rtmp://a.rtmp.youtube.com/live/", "abcd-efgh")).toBe(
			"rtmp://a.rtmp.youtube.com/live/abcd-efgh",
		);
		expect(buildRtmpUrl("rtmp://example.com/live///", "key")).toBe(
			"rtmp://example.com/live/key",
		);
	});
});

const DSHOW_LIST_DEVICES_STDERR = [
	"[dshow @ 000001f2a3b4c5c0] DirectShow video devices (some may be both video and audio devices)",
	'[dshow @ 000001f2a3b4c5c0]  "Integrated Camera"',
	'[dshow @ 000001f2a3b4c5c0]     Alternative name "@device_pnp_\\\\?\\usb#vid_04f2&pid_b6d9#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
	"[dshow @ 000001f2a3b4c5c0] DirectShow audio devices",
	'[dshow @ 000001f2a3b4c5c0]  "Microphone (Realtek(R) Audio)"',
	'[dshow @ 000001f2a3b4c5c0]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{ABCDEF12-3456-7890-ABCD-EF1234567890}"',
	'[dshow @ 000001f2a3b4c5c0]  "Stereo Mix (Realtek(R) Audio)"',
	'[dshow @ 000001f2a3b4c5c0]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{12345678-1234-1234-1234-123456789ABC}"',
	"dummy: Immediate exit requested",
].join("\r\n");

describe("parseDshowAudioDevices", () => {
	it("collects audio device names after the audio header, skipping Alternative name lines", () => {
		expect(parseDshowAudioDevices(DSHOW_LIST_DEVICES_STDERR)).toEqual([
			{ name: "Microphone (Realtek(R) Audio)" },
			{ name: "Stereo Mix (Realtek(R) Audio)" },
		]);
	});

	it("does not pick up video devices listed before the audio header", () => {
		const devices = parseDshowAudioDevices(DSHOW_LIST_DEVICES_STDERR);
		expect(devices.some((d) => d.name.includes("Camera"))).toBe(false);
		expect(devices.some((d) => d.name.includes("@device"))).toBe(false);
	});

	it("returns an empty list when there is no audio devices header", () => {
		expect(parseDshowAudioDevices("[dshow @ 0] DirectShow video devices")).toEqual([]);
		expect(parseDshowAudioDevices("")).toEqual([]);
	});

	it("returns an empty list when the audio section has no devices", () => {
		expect(
			parseDshowAudioDevices(
				"[dshow @ 0] DirectShow audio devices\r\n[dshow @ 0] end of list",
			),
		).toEqual([]);
	});
});
