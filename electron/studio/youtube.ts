import { createServer, type Server } from "node:http";
import { readAppSetting, writeAppSetting } from "../appSettingsStore";
import { deleteSecureSetting, readSecureSetting, writeSecureSetting } from "../secureSettingsStore";
import { shell } from "electron";
import { studioLog } from "./logger";

export const YOUTUBE_OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export const YOUTUBE_REFRESH_TOKEN_KEY = "studio.youtube.refreshToken";
export const YOUTUBE_CLIENT_ID_KEY = "studio.youtube.clientId";
export const YOUTUBE_CLIENT_SECRET_KEY = "studio.youtube.clientSecret";
export const YOUTUBE_CHANNEL_TITLE_KEY = "studio.youtube.channelTitle";

const OAUTH_CALLBACK_PATH = "/callback";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
// Preferred fixed port for the OAuth callback (predictable redirect URI).
// Falls back to a random port if it's taken.
const OAUTH_CALLBACK_PORT = 38472;

const CALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Recordly Studio</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#101014;color:#f2f2f3}main{text-align:center}</style></head><body><main><h1>Signed in</h1><p>You can close this tab and return to Recordly Studio.</p></main></body></html>`;

type FetchFn = typeof fetch;

export function buildOAuthUrl(opts: {
	clientId: string;
	redirectUri: string;
	state?: string;
}): string {
	const params = new URLSearchParams({
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		response_type: "code",
		scope: YOUTUBE_OAUTH_SCOPE,
		access_type: "offline",
		prompt: "consent",
	});
	if (opts.state) {
		params.set("state", opts.state);
	}
	return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface TokenResponse {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return {};
	}
	return payload as Record<string, unknown>;
}

function parseTokenResponse(payload: Record<string, unknown>): TokenResponse {
	const accessToken = payload["access_token"];
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new Error("The Google token endpoint did not return an access token.");
	}
	const refreshToken = payload["refresh_token"];
	const expiresIn = payload["expires_in"];
	return {
		accessToken,
		refreshToken: typeof refreshToken === "string" ? refreshToken : undefined,
		expiresIn: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 0,
	};
}

async function requestTokens(
	body: Record<string, string>,
	fetchFn: FetchFn,
): Promise<TokenResponse> {
	let response: Response;
	try {
		response = await fetchFn(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body).toString(),
		});
	} catch (error) {
		throw new Error(
			`Could not reach the Google token endpoint: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const payload = await readJsonBody(response);
	if (!response.ok) {
		const description = payload["error_description"];
		const code = payload["error"];
		const detail =
			typeof description === "string" && description.length > 0
				? description
				: typeof code === "string" && code.length > 0
					? code
					: `HTTP ${response.status}`;
		throw new Error(`Google sign-in failed: ${detail}`);
	}
	return parseTokenResponse(payload);
}

export async function exchangeCodeForTokens(opts: {
	code: string;
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
	fetchFn?: FetchFn;
}): Promise<TokenResponse> {
	const fetchFn = opts.fetchFn ?? fetch;
	const body: Record<string, string> = {
		code: opts.code,
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		grant_type: "authorization_code",
	};
	// Desktop-app OAuth clients are public clients: Google accepts the token
	// exchange without a client secret.
	if (opts.clientSecret && opts.clientSecret.length > 0) {
		body["client_secret"] = opts.clientSecret;
	}
	return requestTokens(body, fetchFn);
}

export async function refreshAccessToken(opts: {
	refreshToken: string;
	clientId: string;
	clientSecret?: string;
	fetchFn?: FetchFn;
}): Promise<TokenResponse> {
	const fetchFn = opts.fetchFn ?? fetch;
	const body: Record<string, string> = {
		refresh_token: opts.refreshToken,
		client_id: opts.clientId,
		grant_type: "refresh_token",
	};
	if (opts.clientSecret && opts.clientSecret.length > 0) {
		body["client_secret"] = opts.clientSecret;
	}
	return requestTokens(body, fetchFn);
}

export interface LiveIngestion {
	ingestionAddress: string;
	streamName: string;
	channelTitle: string;
}

interface LiveStreamItem {
	cdn?: {
		ingestionInfo?: {
			ingestionAddress?: unknown;
			streamName?: unknown;
		};
	};
}

interface ChannelItem {
	snippet?: {
		title?: unknown;
	};
}

async function getYouTubeJson(
	url: string,
	accessToken: string,
	fetchFn: FetchFn,
): Promise<Record<string, unknown>> {
	const response = await fetchFn(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				"YouTube rejected the request (HTTP 401/403). Reconnect your YouTube account in Settings → Stream.",
			);
		}
		throw new Error(`The YouTube API request failed (HTTP ${response.status}).`);
	}
	return readJsonBody(response);
}

function itemsOf(payload: Record<string, unknown>): unknown[] {
	return Array.isArray(payload["items"]) ? (payload["items"] as unknown[]) : [];
}

export async function fetchLiveIngestion(opts: {
	accessToken: string;
	fetchFn?: FetchFn;
}): Promise<LiveIngestion> {
	const fetchFn = opts.fetchFn ?? fetch;
	const streamsPayload = await getYouTubeJson(
		`${YOUTUBE_API_BASE}/liveStreams?mine=true&part=cdn,snippet`,
		opts.accessToken,
		fetchFn,
	);
	const streamItem = itemsOf(streamsPayload)[0] as LiveStreamItem | undefined;
	const ingestionAddress = streamItem?.cdn?.ingestionInfo?.ingestionAddress;
	const streamName = streamItem?.cdn?.ingestionInfo?.streamName;
	if (
		typeof ingestionAddress !== "string" ||
		ingestionAddress.length === 0 ||
		typeof streamName !== "string" ||
		streamName.length === 0
	) {
		throw new Error(
			"No YouTube live stream found — create one in YouTube Studio (Go Live) first",
		);
	}
	const channelsPayload = await getYouTubeJson(
		`${YOUTUBE_API_BASE}/channels?mine=true&part=snippet`,
		opts.accessToken,
		fetchFn,
	);
	const channelItem = itemsOf(channelsPayload)[0] as ChannelItem | undefined;
	const channelTitle = channelItem?.snippet?.title;
	return {
		ingestionAddress,
		streamName,
		channelTitle: typeof channelTitle === "string" ? channelTitle : "",
	};
}

function openInBrowser(url: string): Promise<void> {
	return shell.openExternal(url);
}

/**
 * Starts a localhost callback server, opens the Google OAuth page in the system
 * browser, and resolves with the authorization code Google redirects back with.
 */
function waitForOAuthCode(clientId: string): Promise<{ code: string; redirectUri: string }> {
	return new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
		let settled = false;
		const server: Server = createServer();
		const timer = setTimeout(() => {
			fail(
				new Error(
					"Timed out waiting for the YouTube sign-in to complete. Please try again.",
				),
			);
		}, OAUTH_TIMEOUT_MS);
		if (typeof timer.unref === "function") {
			timer.unref();
		}

		function fail(error: Error): void {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			server.close();
			reject(error);
		}

		server.on("request", (request, response) => {
			let url: URL | null = null;
			try {
				url = new URL(request.url ?? "/", "http://127.0.0.1");
			} catch {
				url = null;
			}
			if (!url || url.pathname !== OAUTH_CALLBACK_PATH) {
				response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Not found");
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				response.end(CALLBACK_HTML);
				const description = url.searchParams.get("error_description");
				fail(
					new Error(
						description && description.length > 0
							? `YouTube sign-in failed: ${description}`
							: `YouTube sign-in failed (${error}).`,
					),
				);
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Missing authorization code");
				return;
			}
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(CALLBACK_HTML);
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : 0;
			server.close();
			resolve({ code, redirectUri: `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}` });
		});

		// Try the fixed port first (predictable redirect URI), fall back to random
		// port if it's taken. Any other server error is fatal.
		let fallbackAttempted = false;
		server.on("error", (error: NodeJS.ErrnoException) => {
			if (!fallbackAttempted && error.code === "EADDRINUSE") {
				fallbackAttempted = true;
				server.listen(0, "127.0.0.1", () => {
					onServerListening();
				});
				return;
			}
			fail(new Error(`Could not start the local sign-in callback server: ${error.message}`));
		});

		server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
			onServerListening();
		});

		function onServerListening(): void {
			const address = server.address();
			if (!address || typeof address === "string") {
				fail(new Error("Could not start the local sign-in callback server."));
				return;
			}
			const redirectUri = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`;
			let opened: Promise<void>;
			try {
				opened = openInBrowser(buildOAuthUrl({ clientId, redirectUri }));
			} catch {
				fail(
					new Error(
						"Could not open the browser to sign in to YouTube. Check that a default browser is installed and try again.",
					),
				);
				return;
			}
			opened.catch(() => {
				fail(
					new Error(
						"Could not open the browser to sign in to YouTube. Check that a default browser is installed and try again.",
					),
				);
			});
		}
	});
}

export interface YouTubeConnectResult {
	channelTitle: string;
}

export async function connectYouTubeAccount(opts: {
	clientId: string;
	clientSecret?: string;
}): Promise<YouTubeConnectResult> {
	const clientId = opts.clientId.trim();
	const clientSecret = (opts.clientSecret ?? "").trim();
	if (clientId.length === 0) {
		throw new Error("Enter your Google OAuth client ID in the YouTube section first.");
	}
	const { code, redirectUri } = await waitForOAuthCode(clientId);
	const tokens = await exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri });
	if (!tokens.refreshToken) {
		throw new Error(
			"Google did not return a refresh token. Please try connecting your account again.",
		);
	}
	writeSecureSetting(YOUTUBE_REFRESH_TOKEN_KEY, tokens.refreshToken);
	writeSecureSetting(YOUTUBE_CLIENT_ID_KEY, clientId);
	if (clientSecret.length > 0) {
		writeSecureSetting(YOUTUBE_CLIENT_SECRET_KEY, clientSecret);
	} else {
		deleteSecureSetting(YOUTUBE_CLIENT_SECRET_KEY);
	}
	// Channel title only — the live broadcast/stream is created on demand when
	// the user goes live, so no pre-existing YouTube Studio stream is required.
	const channelsPayload = await getYouTubeJson(
		`${YOUTUBE_API_BASE}/channels?mine=true&part=snippet`,
		tokens.accessToken,
		fetch,
	);
	const channelItem = itemsOf(channelsPayload)[0] as ChannelItem | undefined;
	const channelTitle =
		typeof channelItem?.snippet?.title === "string" ? channelItem.snippet.title : "";
	writeAppSetting(YOUTUBE_CHANNEL_TITLE_KEY, channelTitle);
	return { channelTitle };
}

/** Resolve a fresh access token from the stored refresh token + client ID. */
async function getAccessToken(fetchFn: FetchFn = fetch): Promise<string> {
	const refreshToken = readSecureSetting(YOUTUBE_REFRESH_TOKEN_KEY);
	const clientId = readSecureSetting(YOUTUBE_CLIENT_ID_KEY);
	if (!refreshToken || !clientId) {
		throw new Error("YouTube account is not connected. Connect it first.");
	}
	const clientSecret = readSecureSetting(YOUTUBE_CLIENT_SECRET_KEY) ?? undefined;
	const tokens = await refreshAccessToken({
		refreshToken,
		clientId,
		clientSecret,
		fetchFn,
	});
	return tokens.accessToken;
}

async function youtubeApiRequest(
	method: "GET" | "POST",
	url: string,
	accessToken: string,
	body: unknown,
	fetchFn: FetchFn,
): Promise<Record<string, unknown>> {
	const path = url.split("?")[0].replace(YOUTUBE_API_BASE, "");
	studioLog("youtube", `${method} ${path}`);
	let response: Response;
	try {
		response = await fetchFn(url, {
			method,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (error) {
		studioLog("youtube", `${method} ${path} -> network error: ${error instanceof Error ? error.message : String(error)}`);
		throw new Error(
			`Could not reach the YouTube API: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const payload = await readJsonBody(response);
	studioLog("youtube", `${method} ${path} -> HTTP ${response.status}`);
	if (!response.ok) {
		const message = payload["message"];
		const errors = payload["error"];
		const detail =
			typeof message === "string" && message.length > 0
				? message
				: typeof errors === "string" && errors.length > 0
					? errors
					: `HTTP ${response.status}`;
		throw new Error(`YouTube API error: ${detail}`);
	}
	return payload;
}

export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

export interface YouTubeLiveSetup {
	broadcastId: string;
	ingestionAddress: string;
	streamName: string;
}

/**
 * Full "Go Live" setup: creates a live broadcast (title + privacy), creates a
 * dedicated RTMP stream, and binds them. Returns the RTMP ingestion details.
 * Nothing needs to be pre-created in YouTube Studio.
 */
export async function setupYouTubeLive(opts: {
	title: string;
	description?: string;
	privacyStatus: YouTubePrivacyStatus;
	fetchFn?: FetchFn;
}): Promise<YouTubeLiveSetup> {
	const fetchFn = opts.fetchFn ?? fetch;
	const title = opts.title.trim() || "Live Stream";
	const accessToken = await getAccessToken(fetchFn);

	const broadcastPayload = await youtubeApiRequest(
		"POST",
		`${YOUTUBE_API_BASE}/liveBroadcasts?part=snippet,contentDetails,status`,
		accessToken,
		{
			snippet: {
				title,
				description: opts.description?.trim() ?? "",
				scheduledStartTime: new Date().toISOString(),
			},
			contentDetails: {
				enableAutoStart: true,
				enableAutoStop: true,
			},
			status: {
				privacyStatus: opts.privacyStatus,
				selfDeclaredMadeForKids: false,
			},
		},
		fetchFn,
	);
	const broadcastId = broadcastPayload["id"];
	if (typeof broadcastId !== "string" || broadcastId.length === 0) {
		throw new Error("YouTube did not return a broadcast ID.");
	}
	studioLog("youtube", `broadcast created: id=${broadcastId}`);

	const streamPayload = await youtubeApiRequest(
		"POST",
		`${YOUTUBE_API_BASE}/liveStreams?part=snippet,cdn`,
		accessToken,
		{
			snippet: { title },
			cdn: {
				frameRate: "60fps",
				ingestionType: "rtmp",
				resolution: "1080p",
			},
		},
		fetchFn,
	);
	const streamId = streamPayload["id"];
	const cdn = streamPayload["cdn"] as
		| { ingestionInfo?: { ingestionAddress?: unknown; streamName?: unknown } }
		| undefined;
	const rawIngestionAddress = cdn?.ingestionInfo?.ingestionAddress;
	const streamName = cdn?.ingestionInfo?.streamName;
	if (
		typeof streamId !== "string" ||
		typeof rawIngestionAddress !== "string" ||
		typeof streamName !== "string"
	) {
		throw new Error("YouTube did not return stream ingestion details.");
	}

	await youtubeApiRequest(
		"POST",
		`${YOUTUBE_API_BASE}/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=contentDetails`,
		accessToken,
		{},
		fetchFn,
	);
	studioLog("youtube", `broadcast ${broadcastId} bound to stream ${streamId}`);

	// Prefer RTMPS (port 443) over RTMP (port 1935): port 1935 is blocked on
	// many networks, while 443 (HTTPS) is effectively always open.
	const ingestionAddress = rawIngestionAddress.replace(/^rtmp:\/\//i, "rtmps://");
	studioLog(
		"youtube",
		`ingestion via ${ingestionAddress.replace(/\/[^/]+\/?$/, "/<stream-key>")}`,
	);

	return { broadcastId, ingestionAddress, streamName };
}

/**
 * Transition a broadcast to live/complete. Best-effort: with enableAutoStart
 * YouTube flips to live on first RTMP data, so "already live" is not an error.
 */
export async function transitionYouTubeBroadcast(opts: {
	broadcastId: string;
	broadcastStatus: "live" | "complete";
	fetchFn?: FetchFn;
}): Promise<void> {
	const fetchFn = opts.fetchFn ?? fetch;
	const accessToken = await getAccessToken(fetchFn);
	studioLog("youtube", `transition broadcast ${opts.broadcastId} -> ${opts.broadcastStatus}`);
	try {
		await youtubeApiRequest(
			"POST",
			`${YOUTUBE_API_BASE}/liveBroadcasts/transition?broadcastStatus=${opts.broadcastStatus}&id=${encodeURIComponent(opts.broadcastId)}&part=status`,
			accessToken,
			{},
			fetchFn,
		);
	} catch (error) {
		// Auto-start/auto-stop usually handles this; don't fail the session over it.
		console.warn(
			`[studio] YouTube transition to ${opts.broadcastStatus} failed (non-fatal):`,
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function disconnectYouTubeAccount(): Promise<void> {
	deleteSecureSetting(YOUTUBE_REFRESH_TOKEN_KEY);
	writeAppSetting(YOUTUBE_CHANNEL_TITLE_KEY, null);
}

export async function getYouTubeStatus(): Promise<{ connected: boolean; channelTitle?: string }> {
	const connected = readSecureSetting(YOUTUBE_REFRESH_TOKEN_KEY) != null;
	const channelTitle = readAppSetting(YOUTUBE_CHANNEL_TITLE_KEY);
	if (typeof channelTitle === "string" && channelTitle.length > 0) {
		return { connected, channelTitle };
	}
	return { connected };
}

export interface YouTubeBroadcastStatus {
	broadcastId: string;
	lifeCycleStatus: string;
}

/**
 * Check a broadcast's actual lifecycle status on YouTube's side.
 * lifeCycleStatus: created | ready | testStarting | testing | liveStarting | live | complete
 */
export async function getYouTubeBroadcastStatus(opts: {
	broadcastId: string;
	fetchFn?: FetchFn;
}): Promise<YouTubeBroadcastStatus> {
	const fetchFn = opts.fetchFn ?? fetch;
	const accessToken = await getAccessToken(fetchFn);
	const payload = await youtubeApiRequest(
		"GET",
		`${YOUTUBE_API_BASE}/liveBroadcasts?part=status&id=${encodeURIComponent(opts.broadcastId)}`,
		accessToken,
		undefined,
		fetchFn,
	);
	const item = itemsOf(payload)[0] as { status?: { lifeCycleStatus?: unknown } } | undefined;
	const lifeCycleStatus = item?.status?.lifeCycleStatus;
	studioLog("youtube", `broadcast ${opts.broadcastId} lifeCycleStatus=${String(lifeCycleStatus)}`);
	return {
		broadcastId: opts.broadcastId,
		lifeCycleStatus: typeof lifeCycleStatus === "string" ? lifeCycleStatus : "unknown",
	};
}
