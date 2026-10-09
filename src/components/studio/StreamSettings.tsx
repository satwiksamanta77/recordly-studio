import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { getStudioApi, SERVICE_PRESETS, type StreamService } from "./types";

const STREAM_SETTINGS_KEY = "studio.stream";
const STREAM_KEY_SECRET = "studio.stream.key";
const YT_CLIENT_ID_SECRET = "studio.youtube.clientId";
const YT_CLIENT_SECRET_SECRET = "studio.youtube.clientSecret";

const inputClass =
	"w-full rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none";

export function StreamSettings({ onClose }: { onClose: () => void }) {
	const [service, setService] = useState<StreamService>("youtube");
	const [server, setServer] = useState(SERVICE_PRESETS.youtube.server);
	const [key, setKey] = useState("");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [ytConnected, setYtConnected] = useState(false);
	const [ytChannel, setYtChannel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// Load persisted settings, stream key, YouTube credentials and status.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const api = getStudioApi();
			try {
				const [rawSettings, rawKey, rawClientId, rawClientSecret, ytStatus] =
					await Promise.all([
						api?.studioSettingsGet?.(STREAM_SETTINGS_KEY),
						api?.studioSecretGet?.(STREAM_KEY_SECRET),
						api?.studioSecretGet?.(YT_CLIENT_ID_SECRET),
						api?.studioSecretGet?.(YT_CLIENT_SECRET_SECRET),
						api?.studioYouTubeStatus?.(),
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
						if (typeof saved.server === "string" && saved.server) {
							setServer(saved.server);
						} else {
							setServer(SERVICE_PRESETS[saved.service].server);
						}
					}
				}
				if (typeof rawKey === "string") setKey(rawKey);
				if (typeof rawClientId === "string") setClientId(rawClientId);
				if (typeof rawClientSecret === "string") setClientSecret(rawClientSecret);
				if (ytStatus) {
					setYtConnected(ytStatus.connected);
					setYtChannel(ytStatus.channelTitle ?? "");
				}
			} catch {
				// Settings are best-effort; keep defaults on failure.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const handleServiceChange = (next: StreamService) => {
		setService(next);
		// Autofill the server from presets unless the user chose Custom.
		if (next !== "custom") setServer(SERVICE_PRESETS[next].server);
	};

	const handleConnectYouTube = async () => {
		setError(null);
		setNotice(null);
		if (!clientId.trim()) {
			setError("Enter your Google OAuth Client ID first.");
			return;
		}
		setBusy(true);
		try {
			const result = await getStudioApi()?.studioYouTubeConnect?.({
				clientId: clientId.trim(),
				clientSecret: clientSecret.trim() || undefined,
			});
			if (!result || !result.success) {
				setError(result?.error ?? "YouTube connection failed.");
				return;
			}
			setYtConnected(true);
			setYtChannel(result.channelTitle ?? "");
			// Persist the client ID so reconnect works without re-pasting.
			const api = getStudioApi();
			await api?.studioSecretSet?.(YT_CLIENT_ID_SECRET, clientId.trim());
			if (clientSecret.trim()) {
				await api?.studioSecretSet?.(YT_CLIENT_SECRET_SECRET, clientSecret.trim());
			}
			setNotice(
				result.channelTitle
					? `Connected as ${result.channelTitle}.`
					: "YouTube account connected.",
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "YouTube connection failed.");
		} finally {
			setBusy(false);
		}
	};

	const handleDisconnectYouTube = async () => {
		setError(null);
		setNotice(null);
		setBusy(true);
		try {
			await getStudioApi()?.studioYouTubeDisconnect?.();
			setYtConnected(false);
			setYtChannel("");
			setServer("");
			setKey("");
			await getStudioApi()?.studioSecretDelete?.(STREAM_KEY_SECRET);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Disconnect failed.");
		} finally {
			setBusy(false);
		}
	};

	const handleSave = async () => {
		setError(null);
		setNotice(null);
		setBusy(true);
		try {
			const api = getStudioApi();
			await api?.studioSettingsSet?.(STREAM_SETTINGS_KEY, { service, server });
			if (key) {
				await api?.studioSecretSet?.(STREAM_KEY_SECRET, key);
			} else {
				await api?.studioSecretDelete?.(STREAM_KEY_SECRET);
			}
			if (clientId.trim()) await api?.studioSecretSet?.(YT_CLIENT_ID_SECRET, clientId.trim());
			if (clientSecret.trim())
				await api?.studioSecretSet?.(YT_CLIENT_SECRET_SECRET, clientSecret.trim());
			setNotice("Settings saved.");
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to save settings.");
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
				className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-base font-semibold text-zinc-100">Stream Settings</h2>
					<button
						type="button"
						aria-label="Close settings"
						className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						onClick={onClose}
					>
						✕
					</button>
				</div>

				<div className="flex flex-col gap-4">
					<label className="block">
						<span className="mb-1 block text-xs text-zinc-400">Service</span>
						<select
							value={service}
							onChange={(e) => handleServiceChange(e.target.value as StreamService)}
							className={inputClass}
						>
							{(Object.keys(SERVICE_PRESETS) as StreamService[]).map((s) => (
								<option key={s} value={s}>
									{SERVICE_PRESETS[s].label}
								</option>
							))}
						</select>
					</label>

					<label className="block">
						<span className="mb-1 block text-xs text-zinc-400">Server URL</span>
						<input
							value={server}
							onChange={(e) => setServer(e.target.value)}
							placeholder="rtmp://…"
							className={inputClass}
						/>
					</label>

					<label className="block">
						<span className="mb-1 block text-xs text-zinc-400">Stream Key</span>
						<input
							type="password"
							value={key}
							onChange={(e) => setKey(e.target.value)}
							placeholder="Stored securely"
							className={inputClass}
						/>
					</label>

					<div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
						<h3 className="mb-2 text-sm font-semibold text-zinc-200">YouTube</h3>

						<details className="mb-3 rounded border border-zinc-800 bg-zinc-900 px-3 py-2">
							<summary className="cursor-pointer text-xs font-medium text-zinc-300">
								Setup guide — get a Google OAuth Client ID
							</summary>
							<ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-zinc-400">
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
									and create (or select) a project.
								</li>
								<li>Enable the “YouTube Data API v3” for the project.</li>
								<li>
									Go to APIs &amp; Services → Credentials → Create Credentials →
									OAuth client ID → application type “Desktop app”.
								</li>
								<li>Copy the Client ID into the field below (no secret needed).</li>
								<li>
									Press “Connect YouTube account”, sign in with Google, and
									approve access.
								</li>
							</ol>
						</details>

						<label className="mb-2 block">
							<span className="mb-1 block text-xs text-zinc-400">Client ID</span>
							<input
								value={clientId}
								onChange={(e) => setClientId(e.target.value)}
								placeholder="Google OAuth Client ID"
								className={inputClass}
							/>
						</label>
						<label className="mb-3 block">
							<span className="mb-1 block text-xs text-zinc-400">
								Client Secret <span className="text-zinc-500">(optional)</span>
							</span>
							<input
								type="password"
								value={clientSecret}
								onChange={(e) => setClientSecret(e.target.value)}
								placeholder="Google OAuth Client Secret"
								className={inputClass}
							/>
						</label>

						{ytConnected ? (
							<div className="flex items-center justify-between gap-2">
								<p className="text-xs text-green-400">
									Connected{ytChannel ? ` as ${ytChannel}` : ""}
								</p>
								<Button
									size="sm"
									variant="outline"
									isDisabled={busy}
									onPress={handleDisconnectYouTube}
								>
									Disconnect
								</Button>
							</div>
						) : (
							<Button
								size="sm"
								variant="secondary"
								isDisabled={busy}
								onPress={handleConnectYouTube}
							>
								Connect YouTube account
							</Button>
						)}
					</div>

					{error && <p className="text-xs text-red-400">{error}</p>}
					{notice && <p className="text-xs text-green-400">{notice}</p>}

					<div className="flex justify-end gap-2">
						<Button variant="ghost" onPress={onClose} isDisabled={busy}>
							Cancel
						</Button>
						<Button onPress={handleSave} isDisabled={busy}>
							Save
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
