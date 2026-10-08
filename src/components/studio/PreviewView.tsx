import { createElement, type ElementType, useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "./StudioContext";
import { CANVAS_HEIGHT, CANVAS_WIDTH, type StudioSource } from "./types";

/**
 * 16:9 preview area. Each visible video source's scene item is absolutely
 * positioned on the 1920x1080 canvas using percentage coordinates.
 */
export function PreviewView() {
	const { sources, scene } = useStudio();
	const sourcesById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

	return (
		<div className="relative aspect-video w-full select-none overflow-hidden rounded-lg bg-black">
			{scene.items.map((item) => {
				const source = sourcesById.get(item.sourceId);
				if (!source || !item.visible || source.kind === "audio-input") return null;
				return (
					<div
						key={source.id}
						className="absolute"
						style={{
							left: `${(item.x / CANVAS_WIDTH) * 100}%`,
							top: `${(item.y / CANVAS_HEIGHT) * 100}%`,
							width: `${(item.width / CANVAS_WIDTH) * 100}%`,
							height: `${(item.height / CANVAS_HEIGHT) * 100}%`,
						}}
					>
						{source.kind === "browser" ? (
							<BrowserTile source={source} />
						) : (
							<CaptureTile source={source} />
						)}
					</div>
				);
			})}
		</div>
	);
}

/** Mandatory constraints for Electron desktopCapturer streams. */
interface DesktopVideoConstraints extends MediaTrackConstraints {
	mandatory: { chromeMediaSource: "desktop"; chromeMediaSourceId: string };
}

function CaptureTile({ source }: { source: StudioSource }) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		let stream: MediaStream | null = null;
		const video = videoRef.current;
		const captureId = source.windowId ?? source.captureId;

		if (!video) return;
		if (!captureId) {
			setError("No capture id");
			return;
		}

		const constraints: MediaStreamConstraints = {
			audio: false,
			video: {
				mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: captureId },
			} as unknown as DesktopVideoConstraints,
		};

		navigator.mediaDevices
			.getUserMedia(constraints)
			.then((s) => {
				if (cancelled) {
					s.getTracks().forEach((t) => t.stop());
					return;
				}
				stream = s;
				video.srcObject = s;
				// Autoplay may be rejected if the element isn't visible yet; the
				// stream still renders once playback is allowed.
				video.play().catch(() => {
					/* autoplay blocked */
				});
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : "Capture failed");
			});

		return () => {
			cancelled = true;
			if (stream) stream.getTracks().forEach((t) => t.stop());
			if (video) video.srcObject = null;
		};
	}, [source.windowId, source.captureId]);

	if (error) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-zinc-900 p-2 text-center">
				<span className="text-xs text-zinc-500">{source.name}</span>
			</div>
		);
	}

	return (
		<video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />
	);
}

function BrowserTile({ source }: { source: StudioSource }) {
	if (!source.url) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-zinc-900 p-2 text-center">
				<span className="text-xs text-zinc-500">{source.name}</span>
			</div>
		);
	}
	// React 19 types have no <webview> intrinsic, so use createElement with a
	// string element type (Electron provides the webview element at runtime).
	const Webview = "webview" as unknown as ElementType;
	return createElement(Webview, {
		src: source.url,
		style: { width: "100%", height: "100%" },
	});
}
