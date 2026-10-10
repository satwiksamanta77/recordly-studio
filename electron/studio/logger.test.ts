import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp/recordly-test-user-data"),
		setPath: vi.fn(),
		getVersion: vi.fn(() => "1.0.0-test"),
	},
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (s: string) => Buffer.from(s, "utf-8"),
		decryptString: (b: Buffer) => b.toString("utf-8"),
	},
	shell: { openExternal: vi.fn() },
}));

import { getStudioLogs, redactSecrets, studioLog } from "./logger";

describe("redactSecrets", () => {
	it("redacts stream keys embedded in RTMP URLs", () => {
		const line = redactSecrets("connecting to rtmp://a.rtmp.youtube.com/live2/abc-def-ghi");
		expect(line).toContain("rtmp://a.rtmp.youtube.com/live2/<stream-key>");
		expect(line).not.toContain("abc-def-ghi");
	});

	it("redacts bearer tokens", () => {
		const line = redactSecrets("auth: Bearer ya29.secret-token-value");
		expect(line).toContain("Bearer <token>");
		expect(line).not.toContain("ya29.secret-token-value");
	});

	it("redacts client secrets and refresh tokens in JSON", () => {
		const line = redactSecrets('{"client_secret": "shhh", "refresh_token": "rt-123"}');
		expect(line).not.toContain("shhh");
		expect(line).not.toContain("rt-123");
	});

	it("redacts OAuth auth codes in URLs", () => {
		const line = redactSecrets("callback?code=4/0auth-code-here&scope=x");
		expect(line).not.toContain("4/0auth-code-here");
	});

	it("leaves ordinary lines untouched", () => {
		const line = "broadcast created: id=abc123";
		expect(redactSecrets(line)).toBe(line);
	});
});

describe("studioLog ring buffer", () => {
	it("buffers timestamped lines and caps at the max", () => {
		for (let i = 0; i < 600; i++) {
			studioLog("test", `line ${i}`);
		}
		const logs = getStudioLogs();
		expect(logs.length).toBe(500);
		expect(logs[0]).toContain("line 100");
		expect(logs[logs.length - 1]).toContain("line 599");
	});

	it("prefixes scope and redacts secrets", () => {
		studioLog("ffmpeg", "rtmp://host/app/mysecretkey failed");
		const logs = getStudioLogs();
		const last = logs[logs.length - 1];
		expect(last).toContain("[ffmpeg]");
		expect(last).not.toContain("mysecretkey");
	});
});
