import http from "node:http";
import { STUDIO_CANVAS_HEIGHT, STUDIO_CANVAS_WIDTH } from "./types";

export interface MaskRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const FRAME_BYTES = STUDIO_CANVAS_WIDTH * STUDIO_CANVAS_HEIGHT * 4;
const FRAME_INTERVAL_MS = 200;

/**
 * Serves an infinite rawvideo RGBA mask stream at GET /mask.raw.
 *
 * The shared 1920x1080 buffer is repainted in place by setRects(); every 200ms
 * the current buffer is written to all connected clients. ffmpeg consumes it as
 * `-f rawvideo -pix_fmt rgba -video_size 1920x1080 -i <url>/mask.raw` and
 * overlays it on the composited canvas, so occlusion blackouts apply live with
 * no ffmpeg restart. Black opaque (0,0,0,255) = hide; transparent (alpha 0) =
 * show through.
 */
export function createMaskServer(): Promise<{
	port: number;
	url: string;
	setRects(rects: MaskRect[]): void;
	close(): Promise<void>;
}> {
	return new Promise((resolve, reject) => {
		// Starts fully transparent: every occluder-free frame shows the canvas.
		const buffer = Buffer.alloc(FRAME_BYTES);
		const clients = new Set<http.ServerResponse>();

		const paint = (rects: MaskRect[]) => {
			buffer.fill(0);
			for (const rect of rects) {
				const x0 = Math.max(0, Math.round(rect.x));
				const y0 = Math.max(0, Math.round(rect.y));
				const x1 = Math.min(STUDIO_CANVAS_WIDTH, Math.round(rect.x + rect.w));
				const y1 = Math.min(STUDIO_CANVAS_HEIGHT, Math.round(rect.y + rect.h));
				for (let y = y0; y < y1; y++) {
					const rowBase = y * STUDIO_CANVAS_WIDTH * 4;
					for (let x = x0; x < x1; x++) {
						const i = rowBase + x * 4;
						buffer[i] = 0;
						buffer[i + 1] = 0;
						buffer[i + 2] = 0;
						buffer[i + 3] = 255;
					}
				}
			}
		};

		const server = http.createServer((req, res) => {
			if (req.method === "GET" && req.url === "/mask.raw") {
				res.writeHead(200, { "Content-Type": "application/octet-stream" });
				clients.add(res);
				const remove = () => {
					clients.delete(res);
				};
				res.on("close", remove);
				res.on("error", remove);
				return;
			}
			res.writeHead(404).end();
		});

		const timer = setInterval(() => {
			for (const res of clients) {
				try {
					res.write(buffer);
				} catch {
					clients.delete(res);
				}
			}
		}, FRAME_INTERVAL_MS);

		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("mask server failed to bind"));
				return;
			}
			resolve({
				port: address.port,
				url: `http://127.0.0.1:${address.port}/mask.raw`,
				setRects: paint,
				close: () =>
					new Promise<void>((resolveClose) => {
						clearInterval(timer);
						for (const res of [...clients]) {
							try {
								res.end();
							} catch {
								// Client already gone.
							}
						}
						clients.clear();
						server.close(() => resolveClose());
					}),
			});
		});
	});
}
