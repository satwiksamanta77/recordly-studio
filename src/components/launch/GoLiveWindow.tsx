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

/**
 * Full-window Go Live experience (windowType=golive). A dedicated centered
 * window — never rendered inside the tiny HUD bar.
 */
export function GoLiveWindow() {
	const [service, setService] = useState<StreamService>("youtube");
	const [server, setServer] = useState(SERVICE_PRESETS.youtube.server);
	const [key, setKey] = useState("");
	const [useManualKey, setUseManualKey] = useState(false);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [showClientIdHelp, setShowClientIdHelp] = useState(false);
	const [ytConnected, setYtConnected] = useState(false);
	const [ytChannel, setYtChannel] = useState("");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [privacy, setPrivacy] = useState<Privacy>("unlisted");
	const [isLive, setIsLive] = useState(false);
	const [liveSince, setLiveSince] = useState<number | null>(null);
	const [sessionState, setSessionState] = useState<string>("idle");
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [ytLifeCycle, setYtLifeCycle] = useState<string | null>(null);
	const [showDiagnostics, setShowDiagnostics] = useState(false);
	const [diagLogs, setDiagLogs] = useState<string[]>([]);
	const [diagInfo, setDiagInfo] = useState<string>("");
	const [copied, setCopied] = useState(false);
	const broadcastIdRef = useRef<string | null>(null);

	const youtubeOAuth = service === "youtube" && !useManualKey;

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const api = getStudioApi();
			try {
				const [rawSettings, rawKey, rawClientId, rawClientSecret, ytStatus, studioState] =
					await Promise.all([
						api?.studioSettingsGet?.(STREAM_SETTINGS_KEY),
						api?.studioSecretGet?.(STREAM_KEY_SECRET),
						api?.studioSecretGet?.(YT_CLIENT_ID_SECRET),
						api?.studioSecretGet?.("studio.youtube.clientSecret"),
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
				if (typeof rawClientSecret === "string") setClientSecret(rawClientSecret);
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
			const s = next as { state?: unknown; mode?: unknown; startedAt?: unknown; error?: unknown };
			const state = typeof s.state === "string" ? s.state : "idle";
			setSessionState(state);
			setSessionError(typeof s.error === "string" ? s.error : null);
			const live = state === "running" && s.mode === "stream";
			setIsLive(live);
			setLiveSince(live && typeof s.startedAt === "number" ? s.startedAt : null);
			if (!live) setStatus(null);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, []);

	useEffect(() => {
		if (!isLive) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [isLive]);

	// Poll YouTube for the broadcast's actual lifecycle status while live.
	useEffect(() => {
		if (!isLive || service !== "youtube") return;
		let cancelled = false;
		const check = async () => {
			const broadcastId = broadcastIdRef.current;
			if (!broadcastId || cancelled) return;
			try {
				const result = await getStudioApi()?.studioYouTubeBroadcastStatus?.({ broadcastId });
				if (!cancelled && result?.success && result.lifeCycleStatus) {
					setYtLifeCycle(result.lifeCycleStatus);
				}
			} catch {
				// Best-effort.
			}
		};
		void check();
		const t = setInterval(check, 10000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	}, [isLive, service]);

	const loadDiagnostics = async () => {
		try {
			const result = await getStudioApi()?.studioGetDiagnostics?.();
			if (result?.success) {
				setDiagLogs(result.logs ?? []);
				setDiagInfo(
					`App v${result.appVersion} · ${result.platform}/${result.arch}` +
						(result.logFilePath ? ` · log file: ${result.logFilePath}` : ""),
				);
			}
		} catch {
			// Best-effort.
		}
	};

	const handleCopyDiagnostics = async () => {
		const text = `${diagInfo}\n\n${diagLogs.join("\n")}`;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Fallback for older contexts.
			const ta = document.createElement("textarea");
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			document.body.removeChild(ta);
		}
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleServiceChange = (next: StreamService) => {
		setService(next);
		setError(null);
		setStatus(null);
		if (next !== "custom") setServer(SERVICE_PRESETS[next].server);
		if (next !== "youtube") setUseManualKey(false);
	};

	const handleConnectYouTube = async () => {
		setError(null);
		setStatus(null);
		if (!clientId.trim()) {
			setError("Paste your Google OAuth Client ID first — see the setup guide below.");
			setShowClientIdHelp(true);
			return;
		}
		setBusy(true);
		setStatus("Opening your browser for Google sign-in…");
		try {
			const api = getStudioApi();
			const result = await api?.studioYouTubeConnect?.({
				clientId: clientId.trim(),
				clientSecret: clientSecret.trim() || undefined,
			});
			if (!result || !result.success) {
				throw new Error(result?.error ?? "YouTube connection failed.");
			}
			setYtConnected(true);
			setYtChannel(result.channelTitle ?? "");
			await api?.studioSecretSet?.(YT_CLIENT_ID_SECRET, clientId.trim());
			if (clientSecret.trim()) {
				await api?.studioSecretSet?.("studio.youtube.clientSecret", clientSecret.trim());
			}
			setStatus(
				result.channelTitle
					? `Connected as ${result.channelTitle}. You're ready to go live.`
					: "YouTube account connected. You're ready to go live.",
			);
		} catch (e) {
			const message = e instanceof Error ? e.message : "YouTube connection failed.";
			// Google returns "client_secret is missing" when the OAuth client was
			// created as "Web application" instead of "Desktop app".
			setError(
				/secret/i.test(message)
					? `${message} — paste your Client Secret below, or recreate the OAuth client as a "Desktop app" (which needs no secret).`
					: message,
			);
			setStatus(null);
		} finally {
			setBusy(false);
		}
	};

	const handleDisconnectYouTube = async () => {
		setError(null);
		setStatus(null);
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
		const primary = displays?.find((d) => d.x === 0 && d.y === 0) ?? displays?.[0];
		if (!primary) {
			throw new Error("No display found to stream.");
		}
		const sourceId = "golive-display";
		return {
			scene: {
				items: [
					{ sourceId, x: 0, y: 0, width: 1920, height: 1080, visible: true },
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
				setStatus("Creating your YouTube stream…");
				const setup = await api?.studioYouTubeSetupLive?.({
					title: title.trim() || "Live Stream",
					description: description.trim(),
					privacyStatus: privacy,
				});
				if (!setup || !setup.success) {
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

			setStatus("Starting the stream…");
			const { scene, sources } = await buildDisplayScene();
			// Stream-only: no local video file is saved (like OBS).
			const result = await api?.studioStart?.({
				scene,
				sources,
				record: false,
				stream: true,
				streamSettings: { service, server: rtmpServer, key: rtmpKey },
			});
			if (!result || !result.success) {
				throw new Error(result?.error ?? "Failed to start streaming.");
			}
			broadcastIdRef.current = broadcastId;
			if (broadcastId) {
				await api?.studioYouTubeTransition?.({ broadcastId, broadcastStatus: "live" });
			}
			await api?.studioSettingsSet?.(STREAM_SETTINGS_KEY, { service, server });
			if (!youtubeOAuth && rtmpKey) {
				await api?.studioSecretSet?.(STREAM_KEY_SECRET, rtmpKey);
			}
			setIsLive(true);
			setLiveSince(Date.now());
			setStatus("You're live!");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to start streaming.");
			setStatus(null);
		} finally {
			setBusy(false);
		}
	};

	const handleStopStreaming = async () => {
		setError(null);
		setBusy(true);
		setStatus("Ending the stream…");
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
			setYtLifeCycle(null);
			setStatus("Stream ended.");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to stop streaming.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
			<div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
				<div className="flex items-center gap-2.5">
					{isLive ? (
						<span className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-1 text-xs font-bold text-red-400">
							<span className="size-2 animate-pulse rounded-full bg-red-500" />
							LIVE {liveSince ? `· ${formatElapsed(now - liveSince)}` : ""}
						</span>
					) : (
						<h1 className="text-base font-semibold">Go Live</h1>
					)}
				</div>
				<p className="text-xs text-zinc-500">Recordly Studio</p>
			</div>

			<div className="flex-1 overflow-y-auto px-5 py-5">
				{isLive ? (
					<div className="flex flex-col items-center gap-4 py-8 text-center">
						<div className="flex size-16 items-center justify-center rounded-full bg-red-500/15">
							<span className="size-6 animate-pulse rounded-full bg-red-500" />
						</div>
						<div>
							<p className="font-medium">You're live{service === "youtube" ? " on YouTube" : ""}</p>
							<p className="mt-1 text-sm text-zinc-400">
								Your screen is streaming. No video file is being saved.
							</p>
							{service === "youtube" && broadcastIdRef.current && (
								<div className="mt-3">
									{ytLifeCycle === "live" ? (
										<p className="text-xs text-green-300">
											✓ YouTube confirms: LIVE —{" "}
											<a
												className="underline"
												href={`https://www.youtube.com/watch?v=${broadcastIdRef.current}`}
												target="_blank"
												rel="noreferrer"
											>
												watch your stream
											</a>
										</p>
									) : ytLifeCycle ? (
										<p className="text-xs text-amber-300">
											YouTube status: {ytLifeCycle} — waiting for YouTube to pick up
											the stream…
										</p>
									) : (
										<p className="text-xs text-zinc-500">
											Checking YouTube status…{" "}
											<a
												className="text-blue-400 underline"
												href="https://www.youtube.com/livestreaming"
												target="_blank"
												rel="noreferrer"
											>
												open YouTube Studio
											</a>
										</p>
									)}
								</div>
							)}
						</div>
						<Button
							variant="destructive"
							className="w-full"
							isDisabled={busy}
							onPress={handleStopStreaming}
						>
							{busy ? "Ending…" : "End Stream"}
						</Button>
						{status && <p className="text-xs text-zinc-400">{status}</p>}
						{error && <p className="text-xs text-red-400">{error}</p>}
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{(sessionState === "reconnecting" || sessionState === "error") && (
							<div
								className={`rounded-lg border px-3 py-2.5 text-xs ${
									sessionState === "reconnecting"
										? "border-amber-800/50 bg-amber-950/30 text-amber-300"
										: "border-red-800/50 bg-red-950/30 text-red-300"
								}`}
							>
								<p className="font-medium">
									{sessionState === "reconnecting"
										? "Reconnecting to the stream server…"
										: "Stream error"}
								</p>
								{sessionError && <p className="mt-1 opacity-80">{sessionError}</p>}
								<p className="mt-1.5 opacity-70">
									Check the diagnostics below for details.
								</p>
							</div>
						)}
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
											Sign in with Google once — Recordly creates your YouTube
											stream automatically when you go live.
										</p>
										<Button
											className="w-full"
											variant="secondary"
											isDisabled={busy}
											onPress={handleConnectYouTube}
										>
											{busy ? "Waiting for sign-in…" : "Connect YouTube account"}
										</Button>
										<button
											type="button"
											className="mt-2.5 w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300"
											onClick={() => setShowClientIdHelp((v) => !v)}
										>
											{showClientIdHelp ? "Hide setup guide" : "First time? One-time setup"}
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
														choose <strong className="text-zinc-200">“Desktop app”</strong>{" "}
														(not “Web application”).
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
												<label className="mt-2.5 block">
													<span className={labelClass}>
														Client Secret{" "}
														<span className="text-zinc-500">
															(only if Google asks for one)
														</span>
													</span>
													<input
														type="password"
														value={clientSecret}
														onChange={(e) => setClientSecret(e.target.value)}
														placeholder="Only for “Web application” clients"
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
								{service === "youtube" && (
									<p className="text-[11px] text-zinc-500">
										Find it at{" "}
										<a
											className="text-blue-400 underline"
											href="https://www.youtube.com/livestreaming"
											target="_blank"
											rel="noreferrer"
										>
											youtube.com/livestreaming
										</a>{" "}
										→ Stream settings.
									</p>
								)}
							</>
						)}

						{status && <p className="text-xs text-blue-300">{status}</p>}
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

			<div className="border-t border-zinc-800 px-5 py-3">
				<button
					type="button"
					className="w-full text-left text-xs text-zinc-500 underline hover:text-zinc-300"
					onClick={() => {
						const next = !showDiagnostics;
						setShowDiagnostics(next);
						if (next) void loadDiagnostics();
					}}
				>
					{showDiagnostics ? "Hide diagnostics" : "Show diagnostics (for troubleshooting)"}
				</button>
				{showDiagnostics && (
					<div className="mt-2">
						{diagInfo && <p className="mb-1.5 text-[11px] text-zinc-500">{diagInfo}</p>}
						<pre className="max-h-40 overflow-y-auto rounded-lg border border-zinc-800 bg-black/50 p-2.5 font-mono text-[10px] leading-relaxed text-zinc-400">
							{diagLogs.length > 0 ? diagLogs.join("\n") : "No log entries yet."}
						</pre>
						<div className="mt-2 flex gap-2">
							<button
								type="button"
								className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
								onClick={() => void loadDiagnostics()}
							>
								Refresh
							</button>
							<button
								type="button"
								className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
								onClick={() => void handleCopyDiagnostics()}
							>
								{copied ? "Copied!" : "Copy all"}
							</button>
						</div>
						<p className="mt-1.5 text-[10px] text-zinc-600">
							Secrets are redacted. Copy this when reporting an issue.
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
