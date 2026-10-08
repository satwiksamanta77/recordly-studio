import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { PreviewView } from "./PreviewView";
import { SourcesPanel } from "./SourcesPanel";
import { StreamSettings } from "./StreamSettings";
import { StudioProvider, useStudio } from "./StudioContext";
import {
	getStudioApi,
	type StreamService,
	type StudioMode,
	type StudioRuntimeState,
} from "./types";

const STREAM_SETTINGS_KEY = "studio.stream";
const STREAM_KEY_SECRET = "studio.stream.key";

function isRuntimeState(value: unknown): value is StudioRuntimeState {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as StudioRuntimeState).state === "string"
	);
}

export function StudioWindow() {
	return (
		<StudioProvider>
			<StudioShell />
		</StudioProvider>
	);
}

function StudioShell() {
	const { sources, scene } = useStudio();
	const [state, setState] = useState<StudioRuntimeState>({
		state: "idle",
		mode: null,
		recordPath: null,
		startedAt: null,
		error: null,
	});
	const [recordPath, setRecordPath] = useState("");
	const [streamService, setStreamService] = useState<StreamService>("youtube");
	const [streamServer, setStreamServer] = useState("");
	const [streamKey, setStreamKey] = useState("");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Track the live studio state: initial fetch + subscription.
	useEffect(() => {
		let cancelled = false;
		let unsubscribe: (() => void) | undefined;
		(async () => {
			try {
				const initial = await getStudioApi()?.studioGetState?.();
				if (!cancelled && initial && isRuntimeState(initial)) setState(initial);
			} catch {
				// Keep the default idle state.
			}
		})();
		unsubscribe = getStudioApi()?.studioOnStateChanged?.((next: unknown) => {
			if (isRuntimeState(next)) setState(next);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, []);

	// Load persisted stream settings for the start-streaming call.
	const loadStreamSettings = useCallback(async () => {
		try {
			const api = getStudioApi();
			const [rawSettings, rawKey] = await Promise.all([
				api?.studioSettingsGet?.(STREAM_SETTINGS_KEY),
				api?.studioSecretGet?.(STREAM_KEY_SECRET),
			]);
			if (
				typeof rawSettings === "object" &&
				rawSettings !== null &&
				typeof (rawSettings as { service?: unknown }).service === "string"
			) {
				const saved = rawSettings as { service: StreamService; server?: string };
				setStreamService(saved.service);
				if (typeof saved.server === "string") setStreamServer(saved.server);
			}
			if (typeof rawKey === "string") setStreamKey(rawKey);
		} catch {
			// Stream settings are optional until streaming is started.
		}
	}, []);

	useEffect(() => {
		void loadStreamSettings();
	}, [loadStreamSettings]);

	const running = state.state === "running" || state.state === "reconnecting";

	const handleStartRecording = async () => {
		setError(null);
		if (!recordPath.trim()) {
			setError("Enter a recording file path (e.g. C:\\Videos\\studio.mp4).");
			return;
		}
		setBusy(true);
		try {
			const result = await getStudioApi()?.studioStart?.({
				scene,
				sources,
				record: true,
				recordPath: recordPath.trim(),
				stream: false,
			});
			if (!result?.success) setError(result?.error ?? "Failed to start recording.");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to start recording.");
		} finally {
			setBusy(false);
		}
	};

	const handleStartStreaming = async () => {
		setError(null);
		await loadStreamSettings();
		if (!streamServer.trim() || !streamKey) {
			setError("Set the stream server and key in Settings before streaming.");
			return;
		}
		setBusy(true);
		try {
			const result = await getStudioApi()?.studioStart?.({
				scene,
				sources,
				record: false,
				stream: true,
				streamSettings: {
					service: streamService,
					server: streamServer.trim(),
					key: streamKey,
				},
			});
			if (!result?.success) setError(result?.error ?? "Failed to start streaming.");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to start streaming.");
		} finally {
			setBusy(false);
		}
	};

	const handleStop = async () => {
		setError(null);
		setBusy(true);
		try {
			const result = await getStudioApi()?.studioStop?.();
			if (!result?.success) setError(result?.error ?? "Failed to stop.");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to stop.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
			{/* Header */}
			<header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
				<h1 className="text-sm font-semibold tracking-wide">Recordly Studio</h1>
				<StateBadge state={state} />
			</header>

			{/* Preview */}
			<main className="flex min-h-0 flex-1 items-center justify-center p-4">
				<div className="w-full max-w-5xl">
					<PreviewView />
				</div>
			</main>

			{/* Bottom row: sources (left) + controls (right) */}
			<div className="flex h-64 shrink-0 gap-4 border-t border-zinc-800 p-4">
				<div className="w-1/3 min-w-0">
					<SourcesPanel />
				</div>
				<div className="flex min-w-0 flex-1 flex-col rounded-lg bg-zinc-900/80">
					<div className="border-b border-zinc-800 px-3 py-2">
						<span className="text-sm font-semibold text-zinc-200">Controls</span>
					</div>
					<div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
						<label className="block">
							<span className="mb-1 block text-xs text-zinc-400">
								Recording file path
							</span>
							<input
								value={recordPath}
								onChange={(e) => setRecordPath(e.target.value)}
								placeholder="e.g. C:\Videos\studio.mp4"
								disabled={running}
								className="w-full rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
							/>
						</label>
						<div className="flex flex-wrap gap-2">
							<Button
								onPress={handleStartRecording}
								isDisabled={running || busy}
								variant="destructive"
							>
								Start Recording
							</Button>
							<Button onPress={handleStartStreaming} isDisabled={running || busy}>
								Start Streaming
							</Button>
							<Button
								onPress={handleStop}
								isDisabled={!running || busy}
								variant="secondary"
							>
								Stop
							</Button>
							<Button onPress={() => setSettingsOpen(true)} variant="outline">
								Settings
							</Button>
						</div>
						{(error || state.error) && (
							<p className="text-xs text-red-400">{error ?? state.error}</p>
						)}
						{state.recordPath && (
							<p className="truncate text-xs text-zinc-500">
								Recording to: {state.recordPath}
							</p>
						)}
					</div>
				</div>
			</div>

			{settingsOpen && (
				<StreamSettings
					onClose={() => {
						setSettingsOpen(false);
						void loadStreamSettings();
					}}
				/>
			)}
		</div>
	);
}

function StateBadge({ state }: { state: StudioRuntimeState }) {
	const modeLabel = (mode: StudioMode | null) => {
		switch (mode) {
			case "record":
				return "Recording";
			case "stream":
				return "Streaming";
			case "record+stream":
				return "Recording + Streaming";
			default:
				return "";
		}
	};

	if (state.state === "running") {
		const label = modeLabel(state.mode);
		const color =
			state.mode === "stream" ? "bg-blue-500/15 text-blue-400" : "bg-red-500/15 text-red-400";
		return (
			<span className={`rounded-full px-3 py-1 text-xs font-medium ${color}`}>
				● {label || "Running"}
			</span>
		);
	}
	if (state.state === "reconnecting") {
		return (
			<span className="rounded-full bg-yellow-500/15 px-3 py-1 text-xs font-medium text-yellow-400">
				↻ Reconnecting…
			</span>
		);
	}
	if (state.state === "error") {
		return (
			<span className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-medium text-red-400">
				⚠ Error
			</span>
		);
	}
	return (
		<span className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-400">
			Idle
		</span>
	);
}
