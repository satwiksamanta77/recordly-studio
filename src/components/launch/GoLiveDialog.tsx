import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
	getStudioApi,
	SERVICE_PRESETS,
	type DisplayInfo,
	type StreamService,
} from "../studio/types";

const STREAM_SETTINGS_KEY = "studio.stream";
const STREAM_KEY_SECRET = "studio.stream.key";
const YT_CLIENT_ID_SECRET = "studio.youtube.clientId";

type Privacy = "public" | "unlisted" | "private";

const PRIVACY_OPTIONS: { value: Privacy; label: string; hint: string }[] = [
	{ value: "public", label: "Public", hint: "Anyone can watch" },
	{ value: "unlisted", label: "Unlisted", hint: "Only people with the link" },
	{ value: "private", label: "Private", hint: "Only you" },
];

const inputClass =
	"w-full rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none";

const labelClass = "mb-1.5 block text-xs font-medium text-zinc-400";

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function GoLiveDialog({ onClose }: { onClose: () => void }) {
	const [service, setService] = useState<StreamService>("youtube");
	const [server, setServer] = useState(SERVICE_PRESETS.youtube.server);
	const [key, setKey] = useState("");
	const [useManualKey, setUseManualKey] = useState(false);
	const [clientId, setClientId] = useState("");
	const [showClientIdHelp, setShowClientIdHelp] = useState(false);
	const [ytConnected, setYtConnected] = useState(false);
	const [ytChannel, setYtChannel] = useState("");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [privacy, setPrivacy] = useState<Privacy>("unlisted");
	const [isLive, setIsLive] = useState(false);
	const [liveSince, setLiveSince] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const broadcastIdRef = useRef<string | null>(null);

	const youtubeOAuth = service === "youtube" && !useManualKey;

	// Load saved settings + YouTube status + live state.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const api = getStudioApi();
			try {
				const [rawSettings, rawKey, rawClientId, ytStatus, studioState] =
					await Promise.all([
						api?.studioSettingsGet?.(STREAM_SETTINGS_KEY),
						api?.studioSecretGet?.(STREAM_KEY_SECRET),
						api?.studioSecretGet?.(YT_CLIENT_ID_SECRET),
						api?.studioYouTubeStatus?.(),
						api?.studioGetState?.(),
					]);
				if (cancelled) return;
				if (
					typeof rawSettings === "object" &&
					rawSettings !== null &&
					typeof (rawSettings as { service?: unknown }).service === "string"
				) {
					const saved = rawSettings as { service: StreamService; server?: string };
					if (saved.service in SERVICE_PRESETS) {
						setService(saved.service);
						setServer(
							typeof saved.server === "string" && saved.server
								? saved.server
								: SERVICE_PRESETS[saved.service].server,
						);
					}
				}
				if (typeof rawKey === "string") setKey(rawKey);
				if (typeof rawClientId === "string") setClientId(rawClientId);
				if (ytStatus) {
					setYtConnected(ytStatus.connected);
					setYtChannel(ytStatus.channelTitle ?? "");
				}
				if (studioState && studioState.state === "running" && studioState.mode === "stream") {
					setIsLive(true);
					setLiveSince(studioState.startedAt);
				}
			} catch {
				// Best-effort.
			}
		})();
		const unsubscribe = getStudioApi()?.studioOnStateChanged?.((next: unknown) => {
			if (cancelled) return;
			if (typeof next !== "object" || next === null) return;
			const s = next as { state?: unknown; mode?: unknown; startedAt?: unknown };
			const live = s.state === "running" && s.mode === "stream";
			setIsLive(live);
			setLiveSince(
				live && typeof s.startedAt === "number" ? (s.startedAt as number) : null,
			);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, []);

	// Tick the LIVE timer.
	useEffect(() => {
		if (!isLive) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [isLive]);

	const handleServiceChange = (next: StreamService) => {
		setService(next);
		setError(null);
		if (next !== "custom") setServer(SERVICE_PRESETS[next].server);
		if (next !== "youtube") setUseManualKey(false);
	};

	const handleConnectYouTube = async () => {
		setError(null);
		if (!clientId.trim()) {
			setError("Paste your Google OAuth Client ID first (see setup guide below).");
			setShowClientIdHelp(true);
			return;
		}
		setBusy(true);
		try {
			const api = getStudioApi();
			const result = await api?.studioYouTubeConnect?.({ clientId: clientId.trim() });
			if (!result?.success) {
				setError(result?.error ?? "YouTube connection failed.");
				return;
			}
			setYtConnected(true);
			setYtChannel(result.channelTitle ?? "");
			await api?.studioSecretSet?.(YT_CLIENT_ID_SECRET, clientId.trim());
		} catch (e) {
			setError(e instanceof Error ? e.message : "YouTube connection failed.");
		} finally {
			setBusy(false);
		}
	};

	const handleDisconnectYouTube = async () => {
		setError(null);
		setBusy(true);
		try {
			await getStudioApi()?.studioYouTubeDisconnect?.();
			setYtConnected(false);
			setYtChannel("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Disconnect failed.");
		} finally {
			setBusy(false);
		}
	};

	const buildDisplayScene = useCallback(async () => {
		const api = getStudioApi();
		const displays = (await api?.studioGetDisplays?.()) as DisplayInfo[] | undefined;
		const primary =
			displays?.find((d) => d.x === 0 && d.y === 0) ?? displays?.[0];
		if (!primary) {
			throw new Error("No display found to stream.");
		}
		const sourceId = "golive-display";
		return {
			scene: {
				items: [
					{
						sourceId,
						x: 0,
						y: 0,
						width: 1920,
						height: 1080,
						visible: true,
					},
				],
			},
			sources: [
				{
					id: sourceId,
					kind: "display" as const,
					name: primary.label || "Display",
					displayId: primary.id,
				},
			],
		};
	}, []);

	const handleStartStreaming = async () => {
		setError(null);
		setBusy(true);
		try {
			const api = getStudioApi();
			let rtmpServer = server.trim();
			let rtmpKey = key;
			let broadcastId: string | null = null;

			if (youtubeOAuth) {
				if (!ytConnected) {
					throw new Error("Connect your YouTube account first.");
				}
				// Create the YouTube broadcast + stream on demand: title, description
				// and privacy are applied automatically. Nothing to pre-create.
				const setup = await api?.studioYouTubeSetupLive?.({
					title: title.trim() || "Live Stream",
					description: description.trim(),
					privacyStatus: privacy,
				});
				if (!setup?.success) {
					throw new Error(setup?.error ?? "Could not set up the YouTube stream.");
				}
				rtmpServer = setup.ingestionAddress ?? "";
				rtmpKey = setup.streamName ?? "";
				broadcastId = setup.broadcastId ?? null;
				if (!rtmpServer || !rtmpKey) {
					throw new Error("YouTube did not return stream details.");
				}
			} else {
				if (!rtmpServer || !rtmpKey) {
					throw new Error("Enter the stream server URL and stream key.");
				}
			}

			const { scene, sources } = await buildDisplayScene();
			// Stream-only: no local video file is saved (like OBS).
			const result = await api?.studioStart?.({
				scene,
				sources,
				record: false,
				stream: true,
				streamSettings: { service, server: rtmpServer, key: rtmpKey },
			});
			if (!result?.success) {
				throw new Error(result?.error ?? "Failed to start streaming.");
			}
			broadcastIdRef.current = broadcastId;
			if (broadcastId) {
				// Flip the YouTube broadcast live (auto-start usually beats us to it).
				await api?.studioYouTubeTransition?.({ broadcastId, broadcastStatus: "live" });
			}
			// Persist server/key for next time (YouTube OAuth keys are per-broadcast).
			await api?.studioSettingsSet?.(STREAM_SETTINGS_KEY, { service, server });
			if (!youtubeOAuth && rtmpKey) {
				await api?.studioSecretSet?.(STREAM_KEY_SECRET, rtmpKey);
			}
			setIsLive(true);
			setLiveSince(Date.now());
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to start streaming.");
		} finally {
			setBusy(false);
		}
	};

	const handleStopStreaming = async () => {
		setError(null);
		setBusy(true);
		try {
			const api = getStudioApi();
			await api?.studioStop?.();
			const broadcastId = broadcastIdRef.current;
			broadcastIdRef.current = null;
			if (broadcastId) {
				await api?.studioYouTubeTransition?.({ broadcastId, broadcastStatus: "complete" });
			}
			setIsLive(false);
			setLiveSince(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to stop streaming.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
			onClick={onClose}
		>
			<div
				className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-700/60 bg-zinc-900 p-6 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-label="Go live"
			>
				<div className="mb-5 flex items-center justify-between">
					<div className="flex items-center gap-2.5">
						{isLive ? (
							<span className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-bold text-red-400">
								<span className="size-2 animate-pulse rounded-full bg-red-500" />
								LIVE {liveSince ? `· ${formatElapsed(now - liveSince)}` : ""}
							</span>
						) : (
							<h2 className="text-lg font-semibold text-zinc-100">Go Live</h2>
						)}
					</div>
					<button
						type="button"
						aria-label="Close"
						className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						onClick={onClose}
					>
						✕
					</button>
				</div>

				{isLive ? (
					<div className="flex flex-col items-center gap-4 py-4 text-center">
						<p className="text-sm text-zinc-400">
							You are live{service === "youtube" ? " on YouTube" : ""}. Your screen is
							streaming — no video file is being saved.
						</p>
						<Button
							variant="destructive"
							className="w-full"
							isDisabled={busy}
							onPress={handleStopStreaming}
						>
							{busy ? "Stopping…" : "End Stream"}
						</Button>
						{error && <p className="text-xs text-red-400">{error}</p>}
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div>
							<span className={labelClass}>Service</span>
							<div className="grid grid-cols-4 gap-1.5">
								{(Object.keys(SERVICE_PRESETS) as StreamService[])
									.filter((s) => s !== "youtube-rtmps")
									.map((s) => (
										<button
											key={s}
											type="button"
											onClick={() => handleServiceChange(s)}
											className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
												service === s
													? "border-blue-500 bg-blue-500/15 text-blue-300"
													: "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
											}`}
										>
											{SERVICE_PRESETS[s].label}
										</button>
									))}
							</div>
						</div>

						{youtubeOAuth ? (
							<>
								{ytConnected ? (
									<div className="flex items-center justify-between rounded-lg border border-green-800/50 bg-green-950/30 px-3 py-2.5">
										<p className="text-xs text-green-300">
											<span className="mr-1.5 inline-block size-2 rounded-full bg-green-400" />
											Connected{ytChannel ? ` as ${ytChannel}` : ""}
										</p>
										<button
											type="button"
											className="text-xs text-zinc-400 underline hover:text-zinc-200"
											onClick={handleDisconnectYouTube}
											disabled={busy}
										>
											Disconnect
										</button>
									</div>
								) : (
									<div className="rounded-xl border border-zinc-700/60 bg-zinc-800/40 p-4">
										<p className="mb-3 text-xs text-zinc-400">
											Sign in with Google once — Recordly will create your YouTube
											stream automatically when you go live.
										</p>
										<Button
											className="w-full"
											variant="secondary"
											isDisabled={busy}
											onPress={handleConnectYouTube}
										>
											{busy ? "Opening browser…" : "Connect YouTube account"}
										</Button>
										<button
											type="button"
											className="mt-2.5 w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300"
											onClick={() => setShowClientIdHelp((v) => !v)}
										>
											{showClientIdHelp ? "Hide setup guide" : "First time? Get a Client ID"}
										</button>
										{showClientIdHelp && (
											<div className="mt-3 border-t border-zinc-700/60 pt-3">
												<ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-zinc-400">
													<li>
														Open the{" "}
														<a
															className="text-blue-400 underline"
															href="https://console.cloud.google.com/"
															target="_blank"
															rel="noreferrer"
														>
															Google Cloud Console
														</a>{" "}
														and create a project.
													</li>
													<li>Enable “YouTube Data API v3”.</li>
													<li>
														Credentials → Create Credentials → OAuth client ID →
														“Desktop app”.
													</li>
													<li>Paste the Client ID below, then connect.</li>
												</ol>
												<label className="block">
													<span className={labelClass}>Google OAuth Client ID</span>
													<input
														value={clientId}
														onChange={(e) => setClientId(e.target.value)}
														placeholder="xxxx.apps.googleusercontent.com"
														className={inputClass}
													/>
												</label>
											</div>
										)}
										<button
											type="button"
											className="mt-3 w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300"
											onClick={() => setUseManualKey(true)}
										>
											Or paste a stream key manually
										</button>
									</div>
								)}

								<label className="block">
									<span className={labelClass}>Stream title</span>
									<input
										value={title}
										onChange={(e) => setTitle(e.target.value)}
										placeholder="My live stream"
										maxLength={100}
										className={inputClass}
									/>
								</label>

								<label className="block">
									<span className={labelClass}>Description (optional)</span>
									<textarea
										value={description}
										onChange={(e) => setDescription(e.target.value)}
										placeholder="What's this stream about?"
										rows={2}
										maxLength={5000}
										className={`${inputClass} resize-none`}
									/>
								</label>

								<div>
									<span className={labelClass}>Privacy</span>
									<div className="grid grid-cols-3 gap-1.5">
										{PRIVACY_OPTIONS.map((opt) => (
											<button
												key={opt.value}
												type="button"
												title={opt.hint}
												onClick={() => setPrivacy(opt.value)}
												className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
													privacy === opt.value
														? "border-blue-500 bg-blue-500/15 text-blue-300"
														: "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
												}`}
											>
												{opt.label}
											</button>
										))}
									</div>
								</div>
							</>
						) : (
							<>
								{service === "youtube" && (
									<button
										type="button"
										className="text-left text-xs text-zinc-500 underline hover:text-zinc-300"
										onClick={() => setUseManualKey(false)}
									>
										← Back to one-click YouTube connect
									</button>
								)}
								<label className="block">
									<span className={labelClass}>Server URL</span>
									<input
										value={server}
										onChange={(e) => setServer(e.target.value)}
										placeholder="rtmp://…"
										className={inputClass}
									/>
								</label>
								<label className="block">
									<span className={labelClass}>Stream key</span>
									<input
										type="password"
										value={key}
										onChange={(e) => setKey(e.target.value)}
										placeholder="Paste your stream key"
										className={inputClass}
									/>
								</label>
							</>
						)}

						{error && <p className="text-xs text-red-400">{error}</p>}

						<Button
							className="w-full bg-red-600 font-semibold text-white hover:bg-red-500"
							isDisabled={busy}
							onPress={handleStartStreaming}
						>
							{busy ? "Starting…" : "Start Streaming"}
						</Button>
						<p className="text-center text-[11px] text-zinc-500">
							Streams your primary display. Nothing is saved to disk.
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
