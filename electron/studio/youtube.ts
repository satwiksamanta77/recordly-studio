import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { readAppSetting, writeAppSetting } from "../appSettingsStore";
import { deleteSecureSetting, readSecureSetting, writeSecureSetting } from "../secureSettingsStore";

const nodeRequire = createRequire(import.meta.url);

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
	clientSecret: string;
	redirectUri: string;
	fetchFn?: FetchFn;
}): Promise<TokenResponse> {
	const fetchFn = opts.fetchFn ?? fetch;
	return requestTokens(
		{
			code: opts.code,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			redirect_uri: opts.redirectUri,
			grant_type: "authorization_code",
		},
		fetchFn,
	);
}

export async function refreshAccessToken(opts: {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	fetchFn?: FetchFn;
}): Promise<TokenResponse> {
	const fetchFn = opts.fetchFn ?? fetch;
	return requestTokens(
		{
			refresh_token: opts.refreshToken,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			grant_type: "refresh_token",
		},
		fetchFn,
	);
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
	const electron = nodeRequire("electron") as typeof import("electron");
	return electron.shell.openExternal(url);
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

		server.on("error", (error: Error) => {
			fail(new Error(`Could not start the local sign-in callback server: ${error.message}`));
		});

		server.listen(0, "127.0.0.1", () => {
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
		});
	});
}

export interface YouTubeConnectResult {
	channelTitle: string;
	ingestionAddress: string;
	streamName: string;
}

export async function connectYouTubeAccount(opts: {
	clientId: string;
	clientSecret: string;
}): Promise<YouTubeConnectResult> {
	const clientId = opts.clientId.trim();
	const clientSecret = opts.clientSecret.trim();
	if (clientId.length === 0 || clientSecret.length === 0) {
		throw new Error(
			"Enter your Google OAuth client ID and client secret in Settings → Stream first.",
		);
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
	writeSecureSetting(YOUTUBE_CLIENT_SECRET_KEY, clientSecret);
	const ingestion = await fetchLiveIngestion({ accessToken: tokens.accessToken });
	writeAppSetting(YOUTUBE_CHANNEL_TITLE_KEY, ingestion.channelTitle);
	return {
		channelTitle: ingestion.channelTitle,
		ingestionAddress: ingestion.ingestionAddress,
		streamName: ingestion.streamName,
	};
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
