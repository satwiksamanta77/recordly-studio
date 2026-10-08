import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

const STORE_FILE_NAME = "secure-studio-settings.json";

/**
 * Secure (safeStorage-encrypted) setting keys used by Recordly Studio.
 *
 * - "studio.youtube.refreshToken" — Google OAuth refresh token from the YouTube connect flow.
 * - "studio.youtube.clientId"      — Google OAuth client ID entered in Settings → Stream.
 * - "studio.youtube.clientSecret"  — Google OAuth client secret entered in Settings → Stream.
 * - "studio.stream.key"            — stream key for the configured streaming service.
 */
export interface SecureStoreDeps {
	safeStorage?: {
		isEncryptionAvailable(): boolean;
		encryptString(s: string): Buffer;
		decryptString(b: Buffer): string;
	};
	userDataPath?: string;
}

type SafeStorageLike = NonNullable<SecureStoreDeps["safeStorage"]>;

function defaultSafeStorage(): SafeStorageLike {
	const electron = nodeRequire("electron") as typeof import("electron");
	return electron.safeStorage;
}

function defaultUserDataPath(): string {
	const electron = nodeRequire("electron") as typeof import("electron");
	return electron.app.getPath("userData");
}

function resolveDeps(deps: SecureStoreDeps = {}): Required<SecureStoreDeps> {
	return {
		safeStorage: deps.safeStorage ?? defaultSafeStorage(),
		userDataPath: deps.userDataPath ?? defaultUserDataPath(),
	};
}

function requireEncryptionAvailable(safeStorage: SafeStorageLike): void {
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("Secure storage is not available on this system");
	}
}

function storeFilePath(userDataPath: string): string {
	return path.join(userDataPath, STORE_FILE_NAME);
}

function readStore(filePath: string): Record<string, string> {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const store: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				store[key] = value;
			}
		}
		return store;
	} catch {
		return {};
	}
}

function writeStore(filePath: string, store: Record<string, string>): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

/** Reads a single encrypted setting; returns null when the key has never been written. */
export function readSecureSetting(key: string, deps: SecureStoreDeps = {}): string | null {
	const { safeStorage, userDataPath } = resolveDeps(deps);
	requireEncryptionAvailable(safeStorage);
	const encoded = readStore(storeFilePath(userDataPath))[key];
	if (typeof encoded !== "string") {
		return null;
	}
	return safeStorage.decryptString(Buffer.from(encoded, "base64"));
}

/** Encrypts and stores a single setting (read-modify-write of the JSON store file). */
export function writeSecureSetting(key: string, value: string, deps: SecureStoreDeps = {}): void {
	const { safeStorage, userDataPath } = resolveDeps(deps);
	requireEncryptionAvailable(safeStorage);
	const filePath = storeFilePath(userDataPath);
	const store = readStore(filePath);
	store[key] = safeStorage.encryptString(value).toString("base64");
	writeStore(filePath, store);
}

/** Removes a single setting from the encrypted store. */
export function deleteSecureSetting(key: string, deps: SecureStoreDeps = {}): void {
	const { safeStorage, userDataPath } = resolveDeps(deps);
	requireEncryptionAvailable(safeStorage);
	const filePath = storeFilePath(userDataPath);
	const store = readStore(filePath);
	if (!(key in store)) {
		return;
	}
	delete store[key];
	writeStore(filePath, store);
}
