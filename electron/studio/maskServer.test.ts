import http from "node:http";
import { describe, expect, it } from "vitest";
import { createMaskServer } from "./maskServer";

const FRAME_BYTES = 1920 * 1080 * 4;

function getPath(url: string, path: string): Promise<{ status: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		http.get(`${url}${path}`, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
			);
			res.on("error", reject);
		}).on("error", reject);
	});
}

/** Reads the first full mask frame from the infinite stream. */
function readFirstFrame(url: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		const req = http.get(url, (res) => {
			if (res.statusCode !== 200) {
				reject(new Error(`unexpected status ${res.statusCode}`));
				return;
			}
			res.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
				received += chunk.length;
				if (received >= FRAME_BYTES) {
					res.destroy();
					resolve(Buffer.concat(chunks).subarray(0, FRAME_BYTES));
				}
			});
			res.on("error", reject);
		});
		req.on("error", reject);
	});
}

const pixelOffset = (x: number, y: number) => (y * 1920 + x) * 4;

describe("createMaskServer", () => {
	it("streams an all-transparent first frame of 1920*1080*4 bytes", async () => {
		const server = await createMaskServer();
		try {
			const frame = await readFirstFrame(server.url);
			expect(frame.length).toBe(FRAME_BYTES);
			expect(frame.every((byte) => byte === 0)).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("returns 404 for other paths", async () => {
		const server = await createMaskServer();
		try {
			const base = server.url.replace(/\/mask\.raw$/, "");
			const { status } = await getPath(base, "/nope");
			expect(status).toBe(404);
		} finally {
			await server.close();
		}
	});

	it("paints rects opaque black at the expected byte offsets", async () => {
		const server = await createMaskServer();
		try {
			server.setRects([{ x: 10, y: 20, w: 30, h: 40 }]);
			const frame = await readFirstFrame(server.url);

			// Top-left corner of the rect: opaque black.
			const topLeft = pixelOffset(10, 20);
			expect(frame[topLeft]).toBe(0);
			expect(frame[topLeft + 1]).toBe(0);
			expect(frame[topLeft + 2]).toBe(0);
			expect(frame[topLeft + 3]).toBe(255);

			// Bottom-right corner of the rect (39, 59): opaque black.
			const bottomRight = pixelOffset(39, 59);
			expect(frame[bottomRight + 3]).toBe(255);

			// Just outside the rect: still transparent.
			expect(frame[pixelOffset(9, 20) + 3]).toBe(0);
			expect(frame[pixelOffset(40, 59) + 3]).toBe(0);
			expect(frame[pixelOffset(10, 60) + 3]).toBe(0);
			expect(frame[pixelOffset(0, 0) + 3]).toBe(0);
		} finally {
			await server.close();
		}
	});

	it("clips rects to the canvas", async () => {
		const server = await createMaskServer();
		try {
			server.setRects([{ x: 1910, y: 1070, w: 100, h: 100 }]);
			const frame = await readFirstFrame(server.url);
			expect(frame[pixelOffset(1919, 1079) + 3]).toBe(255);
			expect(frame[pixelOffset(1909, 1070) + 3]).toBe(0);
		} finally {
			await server.close();
		}
	});
});
