import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { useStudio } from "./StudioContext";
import {
	type AudioDeviceInfo,
	type DisplayInfo,
	getStudioApi,
	type SourceKind,
	type StudioSource,
	type WindowInfo,
} from "./types";

type AddKind = SourceKind | null;

const KIND_LABELS: Record<SourceKind, string> = {
	display: "Display",
	window: "Window",
	browser: "Browser",
	"audio-input": "Audio",
};

const ADD_MENU: { kind: SourceKind; label: string }[] = [
	{ kind: "display", label: "Display Capture" },
	{ kind: "window", label: "Window Capture" },
	{ kind: "browser", label: "Browser" },
	{ kind: "audio-input", label: "Audio Input" },
];

function newId(): string {
	return crypto.randomUUID();
}

export function SourcesPanel() {
	const {
		sources,
		scene,
		addSource,
		removeSource,
		moveSource,
		toggleSourceVisible,
		renameSource,
	} = useStudio();
	const [menuOpen, setMenuOpen] = useState(false);
	const [dialogKind, setDialogKind] = useState<AddKind>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const visibleById = new Map(scene.items.map((item) => [item.sourceId, item.visible]));

	const openDialog = (kind: SourceKind) => {
		setMenuOpen(false);
		setDialogKind(kind);
	};

	const startRename = (source: StudioSource) => {
		setRenamingId(source.id);
		setRenameValue(source.name);
	};

	const commitRename = () => {
		if (renamingId) {
			const name = renameValue.trim();
			if (name) renameSource(renamingId, name);
		}
		setRenamingId(null);
	};

	return (
		<div className="flex h-full flex-col rounded-lg bg-zinc-900/80">
			<div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
				<span className="text-sm font-semibold text-zinc-200">Sources</span>
				<div className="relative">
					<Button
						size="icon"
						variant="ghost"
						title="Add source"
						aria-label="Add source"
						onPress={() => setMenuOpen((open) => !open)}
					>
						<span className="text-lg leading-none">+</span>
					</Button>
					{menuOpen && (
						<div className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-md border border-zinc-700 bg-zinc-800 shadow-lg">
							{ADD_MENU.map((entry) => (
								<button
									key={entry.kind}
									type="button"
									className="block w-full px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-700"
									onClick={() => openDialog(entry.kind)}
								>
									{entry.label}
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="flex-1 overflow-y-auto p-1">
				{sources.length === 0 && (
					<p className="px-3 py-6 text-center text-xs text-zinc-500">
						No sources yet. Press + to add one.
					</p>
				)}
				{sources.map((source) => {
					const visible = visibleById.get(source.id) ?? true;
					return (
						<div
							key={source.id}
							className="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-zinc-800/70"
						>
							<button
								type="button"
								title={visible ? "Hide" : "Show"}
								aria-label={visible ? `Hide ${source.name}` : `Show ${source.name}`}
								className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
								onClick={() => toggleSourceVisible(source.id)}
							>
								{visible ? "👁" : "🚫"}
							</button>
							{renamingId === source.id ? (
								<input
									autoFocus
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onBlur={commitRename}
									onKeyDown={(e) => {
										if (e.key === "Enter") commitRename();
										if (e.key === "Escape") setRenamingId(null);
									}}
									className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-100"
								/>
							) : (
								<button
									type="button"
									title="Double-click to rename"
									onDoubleClick={() => startRename(source)}
									className="min-w-0 flex-1 truncate text-left text-sm text-zinc-200"
								>
									{source.name}
								</button>
							)}
							<span className="shrink-0 rounded bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
								{KIND_LABELS[source.kind]}
							</span>
							<button
								type="button"
								title="Move up (higher layer)"
								aria-label={`Move ${source.name} up`}
								className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
								onClick={() => moveSource(source.id, "up")}
							>
								↑
							</button>
							<button
								type="button"
								title="Move down (lower layer)"
								aria-label={`Move ${source.name} down`}
								className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
								onClick={() => moveSource(source.id, "down")}
							>
								↓
							</button>
							<button
								type="button"
								title="Remove source"
								aria-label={`Remove ${source.name}`}
								className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-red-400"
								onClick={() => removeSource(source.id)}
							>
								✕
							</button>
						</div>
					);
				})}
			</div>

			{dialogKind && (
				<AddSourceDialog
					kind={dialogKind}
					onClose={() => setDialogKind(null)}
					onAdd={addSource}
				/>
			)}
		</div>
	);
}

function DialogShell({
	title,
	children,
	onClose,
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-40 flex items-center justify-center bg-black/70"
			onClick={onClose}
		>
			<div
				className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-3 flex items-center justify-between">
					<h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
					<button
						type="button"
						aria-label="Close"
						className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						onClick={onClose}
					>
						✕
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

const inputClass =
	"w-full rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none";

function AddSourceDialog({
	kind,
	onClose,
	onAdd,
}: {
	kind: SourceKind;
	onClose: () => void;
	onAdd: (source: StudioSource) => void;
}) {
	const [name, setName] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const finish = (source: StudioSource) => {
		onAdd({ ...source, name: name.trim() || source.name });
		onClose();
	};

	return (
		<DialogShell
			title={`Add ${ADD_MENU.find((m) => m.kind === kind)?.label ?? "Source"}`}
			onClose={onClose}
		>
			<label className="mb-3 block">
				<span className="mb-1 block text-xs text-zinc-400">Source name</span>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Optional custom name"
					className={inputClass}
				/>
			</label>

			{kind === "display" && (
				<DisplayPicker
					loading={loading}
					setLoading={setLoading}
					setError={setError}
					onPick={(d) =>
						finish({
							id: newId(),
							kind: "display",
							name: d.label,
							displayId: d.id,
							captureId: d.captureId,
						})
					}
				/>
			)}
			{kind === "window" && (
				<WindowPicker
					loading={loading}
					setLoading={setLoading}
					setError={setError}
					onPick={(w) =>
						finish({
							id: newId(),
							kind: "window",
							name: w.name,
							windowId: w.id,
							windowTitle: w.name,
						})
					}
				/>
			)}
			{kind === "browser" && (
				<BrowserForm
					onAdd={(url) => finish({ id: newId(), kind: "browser", name: url, url })}
				/>
			)}
			{kind === "audio-input" && (
				<AudioPicker
					loading={loading}
					setLoading={setLoading}
					setError={setError}
					onPick={(device) =>
						finish({
							id: newId(),
							kind: "audio-input",
							name: device.name,
							deviceName: device.name,
						})
					}
				/>
			)}

			{error && <p className="mt-2 text-xs text-red-400">{error}</p>}
		</DialogShell>
	);
}

type PickerProps<T> = {
	loading: boolean;
	setLoading: (v: boolean) => void;
	setError: (v: string | null) => void;
	onPick: (item: T) => void;
};

function DisplayPicker(props: PickerProps<DisplayInfo>) {
	const { loading, setLoading, setError, onPick } = props;
	const [displays, setDisplays] = useState<DisplayInfo[]>([]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoading(true);
			setError(null);
			try {
				const list = (await getStudioApi()?.studioGetDisplays?.()) ?? [];
				if (!cancelled) setDisplays(list);
			} catch (e) {
				if (!cancelled)
					setError(e instanceof Error ? e.message : "Failed to list displays");
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [setError, setLoading]);

	if (loading) return <p className="text-sm text-zinc-400">Loading displays…</p>;
	return (
		<div className="flex flex-col gap-1.5">
			{displays.map((d) => (
				<button
					key={d.id}
					type="button"
					className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-700"
					onClick={() => onPick(d)}
				>
					<span className="font-medium">{d.label}</span>
					<span className="ml-2 text-xs text-zinc-400">
						{d.width}×{d.height}
					</span>
				</button>
			))}
			{!loading && displays.length === 0 && (
				<p className="text-sm text-zinc-500">No displays found.</p>
			)}
		</div>
	);
}

function WindowPicker(props: PickerProps<WindowInfo>) {
	const { loading, setLoading, setError, onPick } = props;
	const [windows, setWindows] = useState<WindowInfo[]>([]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoading(true);
			setError(null);
			try {
				const list = (await getStudioApi()?.studioGetWindows?.()) ?? [];
				if (!cancelled) setWindows(list);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : "Failed to list windows");
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [setError, setLoading]);

	if (loading) return <p className="text-sm text-zinc-400">Loading windows…</p>;
	return (
		<div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
			{windows.map((w) => (
				<button
					key={w.id}
					type="button"
					className="truncate rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-700"
					onClick={() => onPick(w)}
				>
					{w.name}
				</button>
			))}
			{!loading && windows.length === 0 && (
				<p className="text-sm text-zinc-500">No windows found.</p>
			)}
		</div>
	);
}

function BrowserForm({ onAdd }: { onAdd: (url: string) => void }) {
	const [url, setUrl] = useState("https://");
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		const trimmed = url.trim();
		if (!/^https?:\/\/.+/.test(trimmed)) {
			setError("Enter a valid http(s) URL.");
			return;
		}
		onAdd(trimmed);
	};

	return (
		<div>
			<label className="mb-1 block text-xs text-zinc-400">URL</label>
			<input
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") submit();
				}}
				placeholder="https://…"
				className={inputClass}
			/>
			{error && <p className="mt-1 text-xs text-red-400">{error}</p>}
			<div className="mt-3 flex justify-end">
				<Button onPress={submit}>Add source</Button>
			</div>
		</div>
	);
}

function AudioPicker(props: PickerProps<AudioDeviceInfo>) {
	const { loading, setLoading, setError, onPick } = props;
	const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoading(true);
			setError(null);
			try {
				const list = (await getStudioApi()?.studioGetAudioDevices?.()) ?? [];
				if (!cancelled) setDevices(list);
			} catch (e) {
				if (!cancelled)
					setError(e instanceof Error ? e.message : "Failed to list audio devices");
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [setError, setLoading]);

	if (loading) return <p className="text-sm text-zinc-400">Loading audio devices…</p>;
	return (
		<div className="flex flex-col gap-1.5">
			{devices.map((d) => (
				<button
					key={d.name}
					type="button"
					className="truncate rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-700"
					onClick={() => onPick(d)}
				>
					{d.name}
				</button>
			))}
			{!loading && devices.length === 0 && (
				<p className="text-sm text-zinc-500">No devices found.</p>
			)}
		</div>
	);
}
