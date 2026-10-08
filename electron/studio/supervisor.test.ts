import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/ffmpeg/binary", () => ({
	getFfmpegBinaryPath: () => "/fake/ffmpeg",
}));

import {
	createStudioSupervisor,
	getReconnectDelayMs,
	type SpawnFn,
	type SupervisorEvents,
} from "./supervisor";

class FakeChild extends EventEmitter {
	stdin = { write: vi.fn() };
	stderr = new EventEmitter();
	kill = vi.fn();
	spawnArgs: { cmd: string; args: string[]; opts: Record<string, unknown> } | null = null;
}

describe("getReconnectDelayMs", () => {
	it("follows the 2s / 5s / 10s / 30s schedule", () => {
		expect(getReconnectDelayMs(0)).toBe(2000);
		expect(getReconnectDelayMs(1)).toBe(5000);
		expect(getReconnectDelayMs(2)).toBe(10000);
		expect(getReconnectDelayMs(3)).toBe(30000);
		expect(getReconnectDelayMs(10)).toBe(30000);
	});
});

describe("createStudioSupervisor", () => {
	let children: FakeChild[];
	let spawnFn: SpawnFn;
	let events: SupervisorEvents;
	let stateChanges: Array<{ state: string; detail?: string }>;

	beforeEach(() => {
		children = [];
		stateChanges = [];
		events = {
			onStateChange: (state, detail) => stateChanges.push({ state, detail }),
			onStats: vi.fn(),
			onUnexpectedExit: vi.fn(),
			onRestartNeeded: vi.fn(),
		};
		spawnFn = (cmd, args, opts) => {
			const child = new FakeChild();
			child.spawnArgs = { cmd, args, opts };
			children.push(child);
			return child as unknown as ChildProcess;
		};
	});

	it("spawns ffmpeg with hidden window and piped stdio", () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		sup.start(["-version"], "record");
		expect(children).toHaveLength(1);
		expect(children[0].spawnArgs?.cmd).toBe("/fake/ffmpeg");
		expect(children[0].spawnArgs?.args).toEqual(["-version"]);
		expect(children[0].spawnArgs?.opts).toMatchObject({
			windowsHide: true,
			stdio: ["pipe", "ignore", "pipe"],
		});
		expect(sup.isRunning()).toBe(true);
		expect(stateChanges).toContainEqual({ state: "running", detail: undefined });
	});

	it("throws when starting while already running", () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		sup.start([], "record");
		expect(() => sup.start([], "record")).toThrow("already running");
	});

	it("parses frame/fps from stderr and reports unexpected exit with stderr tail", () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		sup.start([], "record");
		children[0].stderr.emit(
			"data",
			Buffer.from("frame=   10 fps= 60 q=28.0 size=     123kB time=00:00:00.16\r"),
		);
		expect(events.onStats).toHaveBeenCalledWith({ frame: 10, fps: 60 });

		children[0].emit("close", 1, null);
		expect(sup.isRunning()).toBe(false);
		expect(stateChanges).toContainEqual({
			state: "error",
			detail: "ffmpeg exited unexpectedly (code=1, signal=null)",
		});
		expect(events.onUnexpectedExit).toHaveBeenCalledTimes(1);
		const info = (events.onUnexpectedExit as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(info.code).toBe(1);
		expect(info.stderrTail).toContain("frame=   10 fps= 60");
		// record mode: no reconnect hook
		expect(events.onRestartNeeded).not.toHaveBeenCalled();
	});

	it("keeps only the last ~50 stderr lines in the tail", () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		sup.start([], "record");
		for (let i = 0; i < 60; i++) {
			children[0].stderr.emit("data", Buffer.from(`line-${i}\n`));
		}
		children[0].emit("close", 1, null);
		const info = (events.onUnexpectedExit as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const lines = info.stderrTail.split("\n");
		expect(lines).toHaveLength(50);
		expect(lines[0]).toBe("line-10");
		expect(lines[49]).toBe("line-59");
	});

	it("stop() writes 'q' to stdin and resolves on close", async () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		sup.start([], "record");
		const stopped = sup.stop();
		expect(children[0].stdin.write).toHaveBeenCalledWith("q");
		children[0].emit("close", 0, null);
		await stopped;
		expect(sup.isRunning()).toBe(false);
		expect(stateChanges).toContainEqual({ state: "idle", detail: undefined });
		expect(events.onUnexpectedExit).not.toHaveBeenCalled();
	});

	it("stop() resolves immediately when not running", async () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		await expect(sup.stop()).resolves.toBeUndefined();
	});

	it("handles spawn failure via the error event", () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		sup.start([], "record");
		children[0].emit("error", new Error("ENOENT"));
		expect(events.onUnexpectedExit).toHaveBeenCalledTimes(1);
		expect(stateChanges).toContainEqual({
			state: "error",
			detail: "ffmpeg failed to start: ENOENT",
		});
	});

	it("requests reconnect with backoff in stream mode, resetting attempts on fresh start", async () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });

		sup.start([], "stream");
		children[0].emit("close", 1, null);
		expect(events.onRestartNeeded).toHaveBeenCalledWith("stream", 0, 2000);
		expect(stateChanges).toContainEqual({
			state: "reconnecting",
			detail: "reconnect attempt 1",
		});

		// Host restarts after the crash: the backoff escalates.
		sup.start([], "stream");
		children[1].emit("close", 1, null);
		expect(events.onRestartNeeded).toHaveBeenCalledWith("stream", 1, 5000);

		// A fresh start after stop() resets the attempt counter.
		await sup.stop();
		sup.start([], "stream");
		children[2].emit("close", 1, null);
		expect(events.onRestartNeeded).toHaveBeenLastCalledWith("stream", 0, 2000);
	});

	it("requests reconnect for record+stream mode too", () => {
		const sup = createStudioSupervisor(events, { spawn: spawnFn });
		sup.start([], "record+stream");
		children[0].emit("close", 1, null);
		expect(events.onRestartNeeded).toHaveBeenCalledWith("record+stream", 0, 2000);
	});
});
