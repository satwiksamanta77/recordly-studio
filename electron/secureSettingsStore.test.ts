import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	deleteSecureSetting,
	readSecureSetting,
	type SecureStoreDeps,
	writeSecureSetting,
} from "./secureSettingsStore";

function mockSafeStorage(available = true) {
	return {
		isEncryptionAvailable: () => available,
		encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf-8"),
		decryptString: (b: Buffer) => {
			const text = b.toString("utf-8");
			if (!text.startsWith("enc:")) {
				throw new Error("not an encrypted payload");
			}
			return text.slice("enc:".length);
		},
	};
}

function tempDeps(available = true): { deps: SecureStoreDeps; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "recordly-secure-"));
	return { deps: { safeStorage: mockSafeStorage(available), userDataPath: dir }, dir };
}

describe("secureSettingsStore", () => {
	it("round-trips write → read", () => {
		const { deps, dir } = tempDeps();
		try {
			writeSecureSetting("studio.youtube.refreshToken", "refresh-123", deps);
			expect(readSecureSetting("studio.youtube.refreshToken", deps)).toBe("refresh-123");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stores ciphertext, not the plaintext secret", () => {
		const { deps, dir } = tempDeps();
		try {
			writeSecureSetting("studio.stream.key", "super-secret-key", deps);
			const raw = readFileSync(join(dir, "secure-studio-settings.json"), "utf-8");
			expect(raw).not.toContain("super-secret-key");
			expect(readSecureSetting("studio.stream.key", deps)).toBe("super-secret-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null for a missing key", () => {
		const { deps, dir } = tempDeps();
		try {
			expect(readSecureSetting("studio.youtube.refreshToken", deps)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps multiple keys independent and delete removes only its key", () => {
		const { deps, dir } = tempDeps();
		try {
			writeSecureSetting("studio.youtube.clientId", "cid", deps);
			writeSecureSetting("studio.youtube.clientSecret", "csecret", deps);
			deleteSecureSetting("studio.youtube.clientSecret", deps);
			expect(readSecureSetting("studio.youtube.clientId", deps)).toBe("cid");
			expect(readSecureSetting("studio.youtube.clientSecret", deps)).toBeNull();
			// Deleting a missing key is a no-op.
			deleteSecureSetting("studio.youtube.clientSecret", deps);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists across separate store instances (same userDataPath)", () => {
		const { deps, dir } = tempDeps();
		try {
			writeSecureSetting("studio.youtube.refreshToken", "tok", deps);
			const freshDeps: SecureStoreDeps = {
				safeStorage: mockSafeStorage(true),
				userDataPath: dir,
			};
			expect(readSecureSetting("studio.youtube.refreshToken", freshDeps)).toBe("tok");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws when encryption is unavailable", () => {
		const { deps, dir } = tempDeps(false);
		try {
			expect(() => readSecureSetting("k", deps)).toThrow(
				"Secure storage is not available on this system",
			);
			expect(() => writeSecureSetting("k", "v", deps)).toThrow(
				"Secure storage is not available on this system",
			);
			expect(() => deleteSecureSetting("k", deps)).toThrow(
				"Secure storage is not available on this system",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
