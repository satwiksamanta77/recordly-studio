import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { getFfmpegBinaryPath } from "../ipc/ffmpeg/binary";
import type { StudioRunState, StudioSessionMode } from "./types";
import { studioLog } from "./logger";

/** Injectable process spawner, mirroring node:child_process.spawn. */
export type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export interface SupervisorEvents {
	onStateChange?: (state: StudioRunState, detail?: string) => void;
	onStats?: (stats: { frame?: number; fps?: number }) => void;
	onUnexpectedExit?: (info: {
		code: number | null;
		signal: NodeJS.Signals | null;
		stderrTail: string;
	}) => void;
	/** Streaming reconnect policy hook: return true if the host will call start() again. */
	onRestartNeeded?: (mode: StudioSessionMode, attempt: number, delayMs: number) => void;
}

/** OBS-style reconnect backoff: 2s, 5s, 10s, then 30s forever. */
export function getReconnectDelayMs(attempt: number): number {
	const schedule = [2000, 5000, 10000];
	return schedule[attempt] ?? 30000;
}

const STDERR_TAIL_LINES = 50;
const GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const STATS_PATTERN = /frame=\s*(\d+).*?fps=\s*([\d.]+)/;

export function createStudioSupervisor(
	events: SupervisorEvents = {},
	deps: { spawn?: SpawnFn; getFfmpegPath?: () => string } = {},
): {
	start(args: string[], mode: StudioSessionMode): void;
	stop(): Promise<void>;
	isRunning(): boolean;
} {
	const spawnFn: SpawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
	const resolveFfmpegPath = deps.getFfmpegPath ?? getFfmpegBinaryPath;

	let proc: ChildProcess | null = null;
	let mode: StudioSessionMode | null = null;
	let stopping = false;
	let unexpectedHandled = false;
	let reconnectAttempts = 0;
	let stopPromise: Promise<void> | null = null;
	let lastState: StudioRunState = "idle";
	let stderrTail: string[] = [];

	const emitState = (state: StudioRunState, detail?: string) => {
		lastState = state;
		studioLog("ffmpeg", `state -> ${state}${detail ? ` (${detail})` : ""}`);
		events.onStateChange?.(state, detail);
	};

	const pushStderrLine = (line: string) => {
		if (line.length === 0) return;
		stderrTail.push(line);
		if (stderrTail.length > STDERR_TAIL_LINES) {
			stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
		}
		const match = STATS_PATTERN.exec(line);
		if (match) {
			events.onStats?.({ frame: Number(match[1]), fps: Number(match[2]) });
		}
	};

	const handleUnexpectedExit = (
		code: number | null,
		signal: NodeJS.Signals | null,
		error: Error | null,
	) => {
		if (proc === null || stopping || unexpectedHandled) return;
		unexpectedHandled = true;
		proc = null;
		const sessionMode = mode;
		const detail = error
			? `ffmpeg failed to start: ${error.message}`
			: `ffmpeg exited unexpectedly (code=${code}, signal=${signal})`;
		studioLog("ffmpeg", `${detail}\nstderr tail:\n${stderrTail.slice(-10).join("\n")}`);
		emitState("error", detail);
		events.onUnexpectedExit?.({ code, signal, stderrTail: stderrTail.join("\n") });
		if (sessionMode !== null && sessionMode.includes("stream")) {
			const attempt = reconnectAttempts;
			reconnectAttempts += 1;
			emitState("reconnecting", `reconnect attempt ${attempt + 1}`);
			events.onRestartNeeded?.(sessionMode, attempt, getReconnectDelayMs(attempt));
		}
	};

	function start(args: string[], sessionMode: StudioSessionMode): void {
		if (proc !== null) {
			throw new Error("Studio supervisor is already running");
		}
		// The attempt counter resets on a fresh start, but is preserved when
		// start() is a host-driven crash restart (previous state "reconnecting")
		// so the 2s/5s/10s/30s backoff escalates instead of pinning at 2s.
		if (lastState !== "reconnecting") {
			reconnectAttempts = 0;
		}
		stderrTail = [];
		stopping = false;
		unexpectedHandled = false;
		mode = sessionMode;
		const child = spawnFn(resolveFfmpegPath(), args, {
			windowsHide: true,
			stdio: ["pipe", "ignore", "pipe"],
		});
		proc = child;
		// A broken stdin pipe (e.g. ffmpeg dying instantly) must never crash the host.
		if (typeof child.stdin?.on === "function") {
			child.stdin.on("error", () => {
				// Ignored: stdin failures surface via the process close/error events.
			});
		}
		// ffmpeg writes progress lines separated by \r; split on both \r and \n.
		child.stderr?.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/[\r\n]+/)) {
				pushStderrLine(line);
			}
		});
		child.on("error", (error) => handleUnexpectedExit(null, null, error));
		child.on("close", (code, signal) => handleUnexpectedExit(code, signal, null));
		emitState("running");
	}

	function stop(): Promise<void> {
		if (stopPromise !== null) {
			return stopPromise;
		}
		const child = proc;
		if (child === null) {
			// No process, but a previous crash may have left us in
			// "reconnecting"/"error": stop() always settles the session to idle.
			if (lastState !== "idle") {
				emitState("idle");
			}
			return Promise.resolve();
		}
		stopping = true;
		// Graceful shutdown protocol: ffmpeg quits cleanly when it receives "q"
		// on stdin, which lets it write stream trailers (mp4/flv) before exiting.
		// We wait for the "close" event up to GRACEFUL_STOP_TIMEOUT_MS, then fall
		// back to SIGKILL. The promise always resolves — a hung encoder must not
		// hang the UI, and stop() is idempotent-safe for repeated calls.
		try {
			child.stdin?.write("q");
		} catch {
			// stdin already closed/destroyed; the timeout kill below still applies.
		}
		stopPromise = new Promise<void>((resolve) => {
			let settled = false;
			const settle = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (proc === child) proc = null;
				emitState("idle");
				stopping = false;
				resolve();
			};
			child.once("close", settle);
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already dead; settle below.
				}
				settle();
			}, GRACEFUL_STOP_TIMEOUT_MS);
		}).finally(() => {
			stopPromise = null;
		});
		return stopPromise;
	}

	function isRunning(): boolean {
		return proc !== null;
	}

	return { start, stop, isRunning };
}
