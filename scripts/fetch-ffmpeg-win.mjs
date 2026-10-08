import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Downloads the Windows ffmpeg/ffprobe binaries (gyan.dev essentials build)
// into electron/native/bin/win32-x64/. Needed because the ffmpeg-static npm
// package only ships a binary for the host platform, so a Windows installer
// built on Linux would otherwise bundle the wrong ffmpeg.
//
// The binaries are git-ignored and fetched at build time (see build:win).
// Run: node scripts/fetch-ffmpeg-win.mjs [--force]

const projectRoot = process.cwd();
const destDir = path.join(projectRoot, "electron", "native", "bin", "win32-x64");
const ffmpegDest = path.join(destDir, "ffmpeg.exe");
const ffprobeDest = path.join(destDir, "ffprobe.exe");
const force = process.argv.includes("--force");

const DOWNLOAD_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

if (existsSync(ffmpegDest) && existsSync(ffprobeDest) && !force) {
	console.log("[fetch-ffmpeg-win] Windows ffmpeg/ffprobe already present, skipping.");
	process.exit(0);
}

const tmpDir = path.join(os.tmpdir(), `recordly-ffmpeg-win-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const zipPath = path.join(tmpDir, "ffmpeg.zip");

try {
	console.log("[fetch-ffmpeg-win] Downloading", DOWNLOAD_URL);
	execSync(`curl -fL --retry 3 -o "${zipPath}" "${DOWNLOAD_URL}"`, { stdio: "inherit" });

	console.log("[fetch-ffmpeg-win] Extracting...");
	execSync(`unzip -q -o "${zipPath}" "*/bin/ffmpeg.exe" "*/bin/ffprobe.exe" -d "${tmpDir}"`, {
		stdio: "inherit",
	});

	const entries = execSync(`ls -d "${tmpDir}"/ffmpeg-*-essentials_build`, {
		encoding: "utf-8",
	}).trim().split("\n");
	if (entries.length === 0 || !entries[0]) {
		throw new Error("Could not find extracted ffmpeg build directory");
	}
	const binDir = path.join(entries[0], "bin");

	mkdirSync(destDir, { recursive: true });
	for (const [src, dest] of [
		[path.join(binDir, "ffmpeg.exe"), ffmpegDest],
		[path.join(binDir, "ffprobe.exe"), ffprobeDest],
	]) {
		if (!existsSync(src)) {
			throw new Error(`Expected binary not found in archive: ${src}`);
		}
		execSync(`cp "${src}" "${dest}"`);
		console.log("[fetch-ffmpeg-win] Wrote", dest);
	}

	// Sanity check: must be a Windows PE binary, not something else.
	const fileOut = execSync(`file "${ffmpegDest}"`, { encoding: "utf-8" });
	if (!/PE32\+.*Windows/i.test(fileOut)) {
		throw new Error(`Downloaded ffmpeg.exe does not look like a Windows binary: ${fileOut}`);
	}
	console.log("[fetch-ffmpeg-win] Verified:", fileOut.trim());
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}
