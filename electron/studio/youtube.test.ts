import { describe, expect, it, vi } from "vitest";

// youtube.ts reaches the real "electron" module through ../appSettingsStore →
// ../ipc/constants → ../appPaths, which cannot load under vitest (named imports
// from the electron npm package). Stub it so the module graph resolves; the
// pure helpers under test never touch it.
vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/tmp/recordly-test-user-data"), setPath: vi.fn() },
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (s: string) => Buffer.from(s, "utf-8"),
		decryptString: (b: Buffer) => b.toString("utf-8"),
	},
	shell: { openExternal: vi.fn() },
}));

import {
	buildOAuthUrl,
	connectYouTubeAccount,
	exchangeCodeForTokens,
	fetchLiveIngestion,
	refreshAccessToken,
	YOUTUBE_OAUTH_SCOPE,
} from "./youtube";

type MockResponse = { ok: boolean; status: number; payload: unknown };

function makeFetch(handler: (url: string, init?: RequestInit) => MockResponse): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const { ok, status, payload } = handler(url, init);
		return { ok, status, json: async () => payload };
	}) as typeof fetch;
}

function okJson(payload: unknown): MockResponse {
	return { ok: true, status: 200, payload };
}

function errorJson(status: number, payload: unknown): MockResponse {
	return { ok: false, status, payload };
}

function formBody(init?: RequestInit): URLSearchParams {
	return new URLSearchParams(String(init?.body ?? ""));
}

describe("buildOAuthUrl", () => {
	it("contains every required OAuth parameter", () => {
		const url = new URL(
			buildOAuthUrl({ clientId: "cid-123", redirectUri: "http://127.0.0.1:4567/callback" }),
		);
		expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(url.searchParams.get("client_id")).toBe("cid-123");
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4567/callback");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("scope")).toBe(YOUTUBE_OAUTH_SCOPE);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.has("state")).toBe(false);
	});

	it("includes state when provided", () => {
		const url = new URL(
			buildOAuthUrl({
				clientId: "cid-123",
				redirectUri: "http://127.0.0.1:4567/callback",
				state: "csrf-token",
			}),
		);
		expect(url.searchParams.get("state")).toBe("csrf-token");
	});
});

describe("exchangeCodeForTokens", () => {
	it("POSTs the authorization_code grant and maps snake_case fields", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const fetchFn = makeFetch((url, init) => {
			seenUrl = url;
			seenInit = init;
			return okJson({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
		});

		const result = await exchangeCodeForTokens({
			code: "auth-code",
			clientId: "cid",
			clientSecret: "csecret",
			redirectUri: "http://127.0.0.1:1111/callback",
			fetchFn,
		});

		expect(result).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
		expect(seenUrl).toBe("https://oauth2.googleapis.com/token");
		expect(seenInit?.method).toBe("POST");
		expect(seenInit?.headers).toMatchObject({
			"Content-Type": "application/x-www-form-urlencoded",
		});
		const body = formBody(seenInit);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("auth-code");
		expect(body.get("client_id")).toBe("cid");
		expect(body.get("client_secret")).toBe("csecret");
		expect(body.get("redirect_uri")).toBe("http://127.0.0.1:1111/callback");
	});

	it("throws the server's error description on failure", async () => {
		const fetchFn = makeFetch(() =>
			errorJson(400, {
				error: "invalid_grant",
				error_description: "Bad authorization code.",
			}),
		);
		await expect(
			exchangeCodeForTokens({
				code: "bad",
				clientId: "cid",
				clientSecret: "csecret",
				redirectUri: "http://127.0.0.1:1111/callback",
				fetchFn,
			}),
		).rejects.toThrow("Bad authorization code.");
	});

	it("throws when the response has no access token", async () => {
		const fetchFn = makeFetch(() => okJson({ refresh_token: "rt" }));
		await expect(
			exchangeCodeForTokens({
				code: "c",
				clientId: "cid",
				clientSecret: "csecret",
				redirectUri: "http://127.0.0.1:1111/callback",
				fetchFn,
			}),
		).rejects.toThrow(/access token/i);
	});
});

describe("refreshAccessToken", () => {
	it("POSTs the refresh_token grant", async () => {
		let seenInit: RequestInit | undefined;
		const fetchFn = makeFetch((_url, init) => {
			seenInit = init;
			return okJson({ access_token: "new-at", expires_in: 3600 });
		});

		const result = await refreshAccessToken({
			refreshToken: "rt",
			clientId: "cid",
			clientSecret: "csecret",
			fetchFn,
		});

		expect(result.accessToken).toBe("new-at");
		expect(result.refreshToken).toBeUndefined();
		const body = formBody(seenInit);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("rt");
		expect(body.get("client_id")).toBe("cid");
		expect(body.get("client_secret")).toBe("csecret");
	});
});

describe("fetchLiveIngestion", () => {
	const liveStreamsPayload = {
		items: [
			{
				cdn: {
					ingestionInfo: {
						ingestionAddress: "rtmp://a.rtmp.youtube.com/live2",
						streamName: "abcd-efgh-1234",
					},
				},
			},
		],
	};
	const channelsPayload = { items: [{ snippet: { title: "My Channel" } }] };

	it("parses ingestion address, stream name, and channel title", async () => {
		const seen: { url: string; auth?: string }[] = [];
		const fetchFn = makeFetch((url, init) => {
			const headers = init?.headers as Record<string, string> | undefined;
			seen.push({ url, auth: headers?.["Authorization"] });
			if (url.includes("/liveStreams")) return okJson(liveStreamsPayload);
			if (url.includes("/channels")) return okJson(channelsPayload);
			return errorJson(404, {});
		});

		const result = await fetchLiveIngestion({ accessToken: "at", fetchFn });

		expect(result).toEqual({
			ingestionAddress: "rtmp://a.rtmp.youtube.com/live2",
			streamName: "abcd-efgh-1234",
			channelTitle: "My Channel",
		});
		expect(seen).toHaveLength(2);
		expect(seen[0]?.url).toBe(
			"https://www.googleapis.com/youtube/v3/liveStreams?mine=true&part=cdn,snippet",
		);
		expect(seen[1]?.url).toBe(
			"https://www.googleapis.com/youtube/v3/channels?mine=true&part=snippet",
		);
		for (const call of seen) {
			expect(call.auth).toBe("Bearer at");
		}
	});

	it("throws a helpful error when there are no live streams", async () => {
		const fetchFn = makeFetch((url) => {
			if (url.includes("/liveStreams")) return okJson({ items: [] });
			return okJson(channelsPayload);
		});
		await expect(fetchLiveIngestion({ accessToken: "at", fetchFn })).rejects.toThrow(
			"No YouTube live stream found — create one in YouTube Studio (Go Live) first",
		);
	});
});

describe("connectYouTubeAccount", () => {
	it("rejects before any network activity when credentials are missing", async () => {
		await expect(
			connectYouTubeAccount({ clientId: "  ", clientSecret: "secret" }),
		).rejects.toThrow(/client ID and client secret/i);
		await expect(connectYouTubeAccount({ clientId: "cid", clientSecret: "" })).rejects.toThrow(
			/client ID and client secret/i,
		);
	});
});
