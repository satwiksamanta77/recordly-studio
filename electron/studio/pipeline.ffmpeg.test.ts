/**
 * Real-ffmpeg validation of the Studio pipeline builder (DESIGN §6).
 *
 * Substitutes lavfi sources for the Windows-only gdigrab/dshow inputs but runs
 * the EXACT filter graph, codec flags, and tee muxer string produced by
 * buildStudioFfmpegArgs. This proves the graph/tee syntax is valid; it does not
 * prove Windows capture works (that needs a Windows host with a desktop).
 *
 * Skips gracefully when no ffmpeg binary is available.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildStudioFfmpegArgs } from "./pipeline";
import type { StudioScene, StudioSource } from "./types";

const testDir = path.dirname(fileURLToPath(import.meta.url));
// repo root = ~/workspace/recordly-studio (two levels up from electron/studio)
const repoRoot = path.resolve(testDir, "..", "..");

function resolveFfmpeg(): string | null {
	const candidates = [
		process.env.FFMPEG_PATH,
		path.join(repoRoot, "node_modules", "ffmpeg-static", "ffmpeg"),
		"/usr/bin/ffmpeg",
	].filter((c): c is string => !!c);
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	try {
		const found = execFileSync("which", ["ffmpeg"], { encoding: "utf-8" }).trim();
		if (found) return found;
	} catch {
		/* ignore */
	}
	return null;
}

const ffmpegPath = resolveFfmpeg();
const runIfFfmpeg = ffmpegPath ? it : it.skip;

function lavfiInputFor(group: string[], inputValue: string): string[] {
	const groupStr = group.join(" ");
	if (groupStr.includes("rawvideo") && inputValue.startsWith("http")) {
		// Mask input: transparent black RGBA canvas at 5fps.
		return [
			"-f",
			"lavfi",
			"-i",
			"color=0x00000000:size=1920x1080:rate=5:duration=3,format=rgba",
		];
	}
	// Any gdigrab capture input: synthetic test pattern.
	return ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=3"];
}

describe("studio pipeline (real ffmpeg)", () => {
	runIfFfmpeg(
		"filter graph + tee record/stream encodes 3s successfully",
		() => {
			const sources: StudioSource[] = [
				{ id: "d1", kind: "display", name: "Display 1", displayId: 1 },
				{ id: "w1", kind: "window", name: "Notepad", windowTitle: "Notepad" },
				{ id: "b1", kind: "browser", name: "Browser", url: "https://example.com" },
			];
			const scene: StudioScene = {
				items: [
					{ sourceId: "d1", x: 0, y: 0, width: 1920, height: 1080, visible: true },
					{ sourceId: "w1", x: 100, y: 100, width: 1280, height: 720, visible: true },
					{ sourceId: "b1", x: 320, y: 180, width: 1280, height: 720, visible: true },
				],
			};
			const mp4Path = path.join(tmpdir(), "studio-validate.mp4");
			const flvPath = path.join(tmpdir(), "studio-validate.flv");
			for (const p of [mp4Path, flvPath]) {
				try {
					unlinkSync(p);
				} catch {
					/* ignore */
				}
			}

			const built = buildStudioFfmpegArgs(scene, sources, {
				record: true,
				recordPath: mp4Path,
				stream: true,
				rtmpUrl: "rtmp://127.0.0.1:19350/live/test",
				maskUrl: "http://127.0.0.1:1/mask.raw",
				displays: [{ id: 1, x: 0, y: 0, width: 1920, height: 1080 }],
			});
			expect(built.maskNeeded).toBe(true);

			// Swap Windows-only inputs for lavfi equivalents, keeping the real
			// filter graph, codec flags, and tee structure. Point the tee at
			// local files (flv to a file instead of an RTMP server).
			const transformed: string[] = [];
			let cur: string[] = [];
			let inInputs = true;
			for (let i = 0; i < built.args.length; i++) {
				const t = built.args[i];
				if (inInputs && t === "-filter_complex") inInputs = false;
				if (inInputs && t === "-i") {
					transformed.push(...lavfiInputFor(cur, built.args[i + 1]));
					i++;
					cur = [];
					continue;
				}
				if (inInputs && t === "-f") {
					cur = [t, built.args[i + 1] ?? ""];
					i++;
					// consume the rest of this input's pre-input options up to "-i"
					let j = i + 1;
					while (
						j < built.args.length &&
						built.args[j] !== "-i" &&
						built.args[j] !== "-f"
					) {
						cur.push(built.args[j]);
						j++;
					}
					i = j - 1;
					continue;
				}
				if (t === "-f" && built.args[i + 1] === "tee") {
					transformed.push("-f", "tee");
					const teeValue = built.args[i + 2] as string;
					const rewritten = teeValue.replace(/\[f=flv\].*$/, `[f=flv]${flvPath}`);
					transformed.push(rewritten);
					i += 2;
					continue;
				}
				transformed.push(t);
			}

			const result = spawnSync(ffmpegPath as string, transformed, {
				encoding: "utf-8",
				timeout: 120000,
			});
			if (result.status !== 0) {
				console.error(result.stderr?.slice(-3000));
			}
			expect(result.status).toBe(0);
			for (const p of [mp4Path, flvPath]) {
				expect(existsSync(p)).toBe(true);
				expect(statSync(p).size).toBeGreaterThan(0);
				unlinkSync(p);
			}
		},
		60000,
	);
});
