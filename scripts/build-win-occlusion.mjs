import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// Builds win-occlusion.exe, the tiny helper that reports window occlusion
// geometry (used to guarantee Window Capture never shows other windows).
//
// - On Windows: builds with CMake + MSVC (same pattern as build-windows-capture.mjs).
// - On Linux/macOS: cross-compiles with MinGW (x86_64-w64-mingw32-g++) when available.
// - Otherwise: keeps the prebuilt binary in electron/native/bin/win32-x64/.

const projectRoot = process.cwd();
const sourceDir = path.join(projectRoot, "electron", "native", "win-occlusion");
const bundledDir = path.join(projectRoot, "electron", "native", "bin", "win32-x64");
const bundledExePath = path.join(bundledDir, "win-occlusion.exe");

function tryMingwBuild() {
	const mingw = spawnSync("x86_64-w64-mingw32-g++", ["--version"], {
		stdio: "pipe",
		encoding: "utf-8",
	});
	if (mingw.status !== 0) {
		return false;
	}
	console.log("[build-win-occlusion] Cross-compiling with MinGW...");
	execSync(
		`x86_64-w64-mingw32-g++ -O2 -static -o "${bundledExePath}" "${path.join(sourceDir, "win-occlusion.cpp")}" -ldwmapi`,
		{ stdio: "inherit", cwd: projectRoot },
	);
	return true;
}

mkdirSync(bundledDir, { recursive: true });

if (process.platform === "win32") {
	// Delegate to CMake/MSVC: configure + build into a temp dir, then copy.
	const buildDir = path.join(sourceDir, "build");
	mkdirSync(buildDir, { recursive: true });
	console.log("[build-win-occlusion] Configuring with CMake (MSVC)...");
	execSync(`cmake -S "${sourceDir}" -B "${buildDir}" -A x64`, { stdio: "inherit" });
	execSync(`cmake --build "${buildDir}" --config Release`, { stdio: "inherit" });
	const built = path.join(buildDir, "Release", "win-occlusion.exe");
	if (!existsSync(built)) {
		console.error("[build-win-occlusion] Build succeeded but", built, "not found");
		process.exit(1);
	}
	copyFileSync(built, bundledExePath);
	console.log("[build-win-occlusion] Wrote", bundledExePath);
} else if (tryMingwBuild()) {
	console.log("[build-win-occlusion] Wrote", bundledExePath);
} else if (existsSync(bundledExePath)) {
	console.log(
		"[build-win-occlusion] No Windows toolchain available; keeping prebuilt",
		bundledExePath,
	);
} else {
	console.error(
		"[build-win-occlusion] No MinGW cross-compiler and no prebuilt win-occlusion.exe found.",
	);
	process.exit(1);
}
