import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Studio diagnostics logger: timestamped ring buffer + rolling log file.
 * Secrets (stream keys, tokens, client secrets) are redacted before writing.
 */

const MAX_BUFFER_LINES = 500;
const buffer: string[] = [];

let logFilePath: string | null = null;

function getLogFilePath(): string | null {
	if (logFilePath) return logFilePath;
	try {
		const dir = join(app.getPath("userData"), "logs");
		mkdirSync(dir, { recursive: true });
		const date = new Date().toISOString().slice(0, 10);
		logFilePath = join(dir, `recordly-studio-${date}.log`);
		return logFilePath;
	} catch {
		return null;
	}
}

/** Redact anything that looks like a credential from a log line. */
export function redactSecrets(line: string): string {
	let out = line;
	// RTMP URLs embed the stream key: rtmp://host/app/KEY
	out = out.replace(/(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)([^\s"'|]+)/g, "$1<stream-key>");
	// Bearer tokens
	out = out.replace(/(Bearer\s+)[^\s"']+/gi, "$1<token>");
	// OAuth client secrets / refresh tokens in JSON-ish bodies
	out = out.replace(/("(?:client_secret|refresh_token|access_token|streamName)"\s*:\s*")[^"]*(")/g, "$1<redacted>$2");
	// Google auth codes
	out = out.replace(/(code=)[^&\s"']+/g, "$1<auth-code>");
	return out;
}

function timestamp(): string {
	return new Date().toISOString();
}

export function studioLog(scope: string, message: string): void {
	const line = `[${timestamp()}] [${scope}] ${redactSecrets(message)}`;
	buffer.push(line);
	if (buffer.length > MAX_BUFFER_LINES) {
		buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
	}
	const file = getLogFilePath();
	if (file) {
		try {
			appendFileSync(file, line + "\n", "utf-8");
		} catch {
			// Logging must never break the app.
		}
	}
	// Also mirror to the main-process console for dev visibility.
	console.log(line);
}

/** Return the recent buffered log lines (oldest first). */
export function getStudioLogs(): string[] {
	return [...buffer];
}

/** Absolute path of today's log file, if available. */
export function getStudioLogFilePath(): string | null {
	return getLogFilePath();
}
