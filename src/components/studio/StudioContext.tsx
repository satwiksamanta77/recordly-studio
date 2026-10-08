import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { applyMove, defaultItemRect } from "./sceneUtils";
import { getStudioApi, type SceneItem, type StudioScene, type StudioSource } from "./types";

export interface StudioContextValue {
	sources: StudioSource[];
	scene: StudioScene;
	addSource: (source: StudioSource) => void;
	updateSource: (id: string, patch: Partial<StudioSource>) => void;
	removeSource: (id: string) => void;
	moveSource: (id: string, dir: "up" | "down") => void;
	toggleSourceVisible: (id: string) => void;
	renameSource: (id: string, name: string) => void;
	setItemLayout: (
		sourceId: string,
		patch: Partial<Pick<SceneItem, "x" | "y" | "width" | "height">>,
	) => void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

const SOURCES_KEY = "studio.sources";
const SCENE_KEY = "studio.scene";

function isStudioSourceArray(value: unknown): value is StudioSource[] {
	return (
		Array.isArray(value) &&
		value.every(
			(v) =>
				typeof v === "object" &&
				v !== null &&
				typeof (v as StudioSource).id === "string" &&
				typeof (v as StudioSource).kind === "string",
		)
	);
}

function isSceneItemArray(value: unknown): value is SceneItem[] {
	return (
		Array.isArray(value) &&
		value.every(
			(v) =>
				typeof v === "object" &&
				v !== null &&
				typeof (v as SceneItem).sourceId === "string",
		)
	);
}

export function StudioProvider({ children }: { children: ReactNode }) {
	const [sources, setSources] = useState<StudioSource[]>([]);
	const [scene, setScene] = useState<StudioScene>({ items: [] });
	const loadedRef = useRef(false);

	// Load persisted sources + scene on mount.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const api = getStudioApi();
			try {
				const [rawSources, rawScene] = await Promise.all([
					api?.studioSettingsGet?.(SOURCES_KEY),
					api?.studioSettingsGet?.(SCENE_KEY),
				]);
				if (cancelled) return;
				if (isStudioSourceArray(rawSources)) {
					setSources(rawSources);
					if (isSceneItemArray(rawScene)) {
						const known = new Set(rawSources.map((s) => s.id));
						// Drop items for sources that no longer exist.
						const items = rawScene.filter((item) => known.has(item.sourceId));
						// Ensure every source has exactly one item.
						for (const s of rawSources) {
							if (!items.some((item) => item.sourceId === s.id)) {
								items.push({
									sourceId: s.id,
									visible: true,
									...defaultItemRect(s.kind),
								});
							}
						}
						setScene({ items });
					} else {
						setScene({
							items: rawSources.map((s) => ({
								sourceId: s.id,
								visible: true,
								...defaultItemRect(s.kind),
							})),
						});
					}
				}
			} catch {
				// Persisted state is best-effort; start empty on failure.
			} finally {
				if (!cancelled) loadedRef.current = true;
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Persist on change (after the initial load completes).
	useEffect(() => {
		if (!loadedRef.current) return;
		const api = getStudioApi();
		// Best-effort persistence; failures are intentionally ignored.
		const ignore = () => {
			/* ignore */
		};
		api?.studioSettingsSet?.(SOURCES_KEY, sources).catch(ignore);
		api?.studioSettingsSet?.(SCENE_KEY, scene).catch(ignore);
	}, [sources, scene]);

	const addSource = useCallback((source: StudioSource) => {
		setSources((prev) => (prev.some((s) => s.id === source.id) ? prev : [...prev, source]));
		setScene((prev) =>
			prev.items.some((item) => item.sourceId === source.id)
				? prev
				: {
						items: [
							...prev.items,
							{ sourceId: source.id, visible: true, ...defaultItemRect(source.kind) },
						],
					},
		);
	}, []);

	const updateSource = useCallback((id: string, patch: Partial<StudioSource>) => {
		setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
	}, []);

	const removeSource = useCallback((id: string) => {
		setSources((prev) => prev.filter((s) => s.id !== id));
		setScene((prev) => ({ items: prev.items.filter((item) => item.sourceId !== id) }));
	}, []);

	const moveSource = useCallback((id: string, dir: "up" | "down") => {
		// Reorder the sources array with the same z-order semantics as scene items.
		setSources((prev) => {
			const idx = prev.findIndex((s) => s.id === id);
			const target = dir === "up" ? idx + 1 : idx - 1;
			if (idx < 0 || target < 0 || target >= prev.length) return prev;
			const next = prev.slice();
			const [moved] = next.splice(idx, 1);
			next.splice(target, 0, moved);
			return next;
		});
		setScene((prev) => ({ items: applyMove(prev.items, id, dir) }));
	}, []);

	const toggleSourceVisible = useCallback((id: string) => {
		setScene((prev) => ({
			items: prev.items.map((item) =>
				item.sourceId === id ? { ...item, visible: !item.visible } : item,
			),
		}));
	}, []);

	const renameSource = useCallback((id: string, name: string) => {
		setSources((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
	}, []);

	const setItemLayout = useCallback(
		(sourceId: string, patch: Partial<Pick<SceneItem, "x" | "y" | "width" | "height">>) => {
			setScene((prev) => ({
				items: prev.items.map((item) =>
					item.sourceId === sourceId ? { ...item, ...patch } : item,
				),
			}));
		},
		[],
	);

	const value = useMemo<StudioContextValue>(
		() => ({
			sources,
			scene,
			addSource,
			updateSource,
			removeSource,
			moveSource,
			toggleSourceVisible,
			renameSource,
			setItemLayout,
		}),
		[
			sources,
			scene,
			addSource,
			updateSource,
			removeSource,
			moveSource,
			toggleSourceVisible,
			renameSource,
			setItemLayout,
		],
	);

	return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioContextValue {
	const ctx = useContext(StudioContext);
	if (!ctx) throw new Error("useStudio must be used within a StudioProvider");
	return ctx;
}
