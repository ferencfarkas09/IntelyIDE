// Global drag-and-drop router (alpha Attachments). Modules register DROP TARGETS; one router turns every source
// (Tauri native drag-drop with real paths, HTML5 drag events with File objects, test injection) into normalised
// DropItems and hands them to the best target. Registering is the whole extension API:
//
//   registerDropTarget({ id: "mongo.aiBar", priority: 60, label: "the AI bar", accepts: (items) => items.every((i) => i.mime === "application/json"), isActive: () => true, onDrop: (items) => ... })
//
// Choice order: a target whose `hitTest(x, y)` contains the pointer (and accepts) > the highest `priority` among the
// active, accepting targets. A target with `ignores: true` swallows drops silently (commit box, Changes tree) and only
// shows `hint`. The overlay (modules/attachments/DropOverlay) reads `dropState()`; `platform/` holds no UI.
import { createSignal } from "solid-js";

export type DropKind = "file" | "image" | "text" | "url";

export interface DropItem {
  kind: DropKind;
  name: string;
  mime: string;
  size: number;
  /** Absolute path (native drops, Finder files). Absent for pasted images and browser-dragged data. */
  path?: string;
  /** The data when there is no path (HTML5 File, pasted image). */
  blob?: Blob;
  /** Dragged text or URL. */
  text?: string;
  /** Known only after inspection (native drops list paths only). */
  isDir?: boolean;
}

export interface DropTarget {
  id: string;
  /** Higher wins when the pointer is not over a target's own area. */
  priority: number;
  /** Shown in the overlay: "Drop to attach to <label>". */
  label: string;
  /** Replaces "Drop to attach to <label>" (e.g. "Start a new run with these attachments"). */
  title?: string;
  accepts(items: readonly DropItem[]): boolean;
  isActive(): boolean;
  onDrop(items: DropItem[]): void | Promise<void>;
  /** Screen area of the target, for hover preference and the highlight. */
  element?(): HTMLElement | null | undefined;
  /** Swallows the drop and shows `hint` instead of attaching (commit message box, Changes tree). */
  ignores?: boolean;
  hint?: string;
  /** Why `accepts` said no (a provider without attachment support), shown in the overlay. */
  refusal?(items: readonly DropItem[]): string | undefined;
}

export interface DropState {
  active: boolean;
  items: readonly DropItem[];
  /** True while the item list is only a guess (HTML5 dragover knows kinds, not names). */
  provisional: boolean;
  target?: { id: string; label: string; title?: string; rect?: { x: number; y: number; width: number; height: number } };
  hint?: string;
  position?: { x: number; y: number };
}

const IDLE: DropState = { active: false, items: [], provisional: false };
const [state, setState] = createSignal<DropState>(IDLE);
export const dropState = state;

const targets = new Map<string, DropTarget>();
const [version, setVersion] = createSignal(0);
/** Reactive list of registered targets (for tests and the overlay). */
export const dropTargets = (): DropTarget[] => (version(), [...targets.values()]);

export function registerDropTarget(target: DropTarget): () => void {
  targets.set(target.id, target);
  setVersion((v) => v + 1);
  return () => {
    if (targets.get(target.id) === target) {
      targets.delete(target.id);
      setVersion((v) => v + 1);
    }
  };
}

export function resetDropZone(): void {
  lastNativeDropAt = 0;
  targets.clear();
  setVersion((v) => v + 1);
  setState(IDLE);
}

const rectOf = (el: HTMLElement | null | undefined) => {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : undefined;
};

const hit = (t: DropTarget, p: { x: number; y: number } | undefined): boolean => {
  if (!p) return false;
  const r = rectOf(t.element?.());
  return !!r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
};

export interface Choice {
  target?: DropTarget;
  /** An `ignores` target is under the pointer. */
  ignored?: DropTarget;
}

/** Pure target choice, exported for tests. */
export function chooseTarget(items: readonly DropItem[], pointer?: { x: number; y: number }, all: readonly DropTarget[] = [...targets.values()]): Choice {
  const live = all.filter((t) => t.isActive());
  const under = live.filter((t) => hit(t, pointer));
  const ignored = under.find((t) => t.ignores);
  if (ignored) return { ignored };
  const ok = (t: DropTarget) => !t.ignores && t.accepts(items);
  const direct = under.filter(ok).sort((a, b) => b.priority - a.priority)[0];
  if (direct) return { target: direct };
  const target = live.filter(ok).sort((a, b) => b.priority - a.priority)[0];
  return { target };
}

/** The refusal text of the best active non-ignoring target, if some target would take the drop were it not for caps. */
function refusalFor(items: readonly DropItem[]): string | undefined {
  return [...targets.values()].filter((t) => t.isActive() && !t.ignores && !t.accepts(items)).sort((a, b) => b.priority - a.priority).map((t) => t.refusal?.(items)).find(Boolean);
}

function show(items: readonly DropItem[], provisional: boolean, position?: { x: number; y: number }): void {
  const { target, ignored } = chooseTarget(items, position);
  setState({
    active: true,
    items,
    provisional,
    position,
    target: target ? { id: target.id, label: target.label, title: target.title, rect: rectOf(target.element?.()) } : undefined,
    hint: ignored ? ignored.hint ?? "Drops are ignored here" : target ? undefined : refusalFor(items) ?? "Nothing here accepts these files",
  });
}

export function endDrag(): void {
  setState(IDLE);
}

/** Runs the drop on the chosen target. Returns what happened (for tests and the e2e hook). */
export async function dropItems(items: DropItem[], position?: { x: number; y: number }): Promise<{ handled: boolean; targetId?: string; error?: unknown }> {
  endDrag();
  if (items.length === 0) return { handled: false };
  const { target } = chooseTarget(items, position);
  if (!target) return { handled: false };
  try {
    await target.onDrop(items);
    return { handled: true, targetId: target.id };
  } catch (error) {
    console.error(`Drop target ${target.id} failed`, error);
    return { handled: false, targetId: target.id, error };
  }
}

// ---- item normalisation -------------------------------------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i;
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export const mimeFromName = (name: string): string => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff", pdf: "application/pdf", json: "application/json", md: "text/markdown", txt: "text/plain", csv: "text/csv" } as Record<string, string>
  )[ext] ?? "application/octet-stream";
};

export function itemFromPath(path: string): DropItem {
  const name = baseName(path);
  const image = IMAGE_EXT.test(name);
  return { kind: image ? "image" : "file", name, mime: mimeFromName(name), size: 0, path };
}

export function itemFromFile(file: File, path?: string): DropItem {
  const mime = file.type || mimeFromName(file.name);
  return { kind: mime.startsWith("image/") ? "image" : "file", name: file.name, mime, size: file.size, blob: file, ...(path ? { path } : {}) };
}

/** Items from a DataTransfer at drop time: real File objects first, then dragged URL or text. */
export function itemsFromDataTransfer(dt: DataTransfer): DropItem[] {
  const files = [...(dt.files ?? [])];
  if (files.length) return files.map((f) => itemFromFile(f, (f as File & { path?: string }).path));
  const url = dt.getData?.("text/uri-list");
  if (url) return url.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((u) => ({ kind: "url", name: u, mime: "text/uri-list", size: u.length, text: u }));
  const text = dt.getData?.("text/plain");
  return text ? [{ kind: "text", name: "dropped text", mime: "text/plain", size: text.length, text }] : [];
}

/** Provisional items while dragging: the kinds are known, the names are not. */
function itemsFromDragTypes(dt: DataTransfer): DropItem[] {
  const out: DropItem[] = [];
  for (const it of [...(dt.items ?? [])]) {
    if (it.kind === "file") out.push({ kind: it.type.startsWith("image/") ? "image" : "file", name: "", mime: it.type || "application/octet-stream", size: 0 });
  }
  if (out.length === 0 && dt.types?.includes("Files")) out.push({ kind: "file", name: "", mime: "application/octet-stream", size: 0 });
  return out;
}

// ---- sources ------------------------------------------------------------------------------------------------------

export type NativeDragEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

let nativeItems: DropItem[] = [];
let lastNativeDropAt = 0;
let installed: (() => void) | undefined;

/**
 * Position of a native event in CSS pixels. wry reports view points on macOS, which are CSS pixels already, while Tauri
 * documents the payload as physical pixels. Unverified on a real drag (needs the manual check in docs/attachments.md), so:
 * an explicit `scale` wins; otherwise a coordinate outside the window can only be physical and is divided by the device
 * pixel ratio, anything inside is taken as CSS pixels. The worst case is a wrong hover target, never a wrong file.
 */
const cssPoint = (p: { x: number; y: number }, scale?: number) => {
  if (scale) return { x: p.x / scale, y: p.y / scale };
  const dpr = globalThis.devicePixelRatio || 1;
  const outside = p.x > (globalThis.innerWidth || Infinity) || p.y > (globalThis.innerHeight || Infinity);
  return outside && dpr > 1 ? { x: p.x / dpr, y: p.y / dpr } : p;
};

/** The native (Tauri) source. Exported so the e2e hook and tests can inject payloads. */
export async function handleNativeDrag(e: NativeDragEvent, scale?: number): Promise<void> {
  if (e.type === "enter") {
    nativeItems = e.paths.map(itemFromPath);
    show(nativeItems, false, cssPoint(e.position, scale));
  } else if (e.type === "over") {
    if (nativeItems.length) show(nativeItems, false, cssPoint(e.position, scale));
  } else if (e.type === "drop") {
    const items = e.paths.length ? e.paths.map(itemFromPath) : nativeItems;
    nativeItems = [];
    lastNativeDropAt = Date.now();
    await dropItems(items, cssPoint(e.position, scale));
  } else {
    nativeItems = [];
    endDrag();
  }
}

const hasFiles = (dt: DataTransfer | null) => !!dt && (dt.types?.includes("Files") ?? false);

/** Installs the window listeners; returns the disposer. Safe to call twice. */
export function installDropRouter(): () => void {
  if (installed) return installed;
  const offs: (() => void)[] = [];
  const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture = true) => {
    window.addEventListener(type, fn as EventListener, capture);
    offs.push(() => window.removeEventListener(type, fn as EventListener, capture));
  };
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const dragging = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return false;
    e.preventDefault(); // allow the drop; without it the webview navigates to the file
    clearTimeout(leaveTimer);
    return true;
  };
  on("dragenter", (e) => dragging(e) && show(itemsFromDragTypes(e.dataTransfer!), true, { x: e.clientX, y: e.clientY }));
  on("dragover", (e) => {
    if (!dragging(e)) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    show(itemsFromDragTypes(e.dataTransfer!), true, { x: e.clientX, y: e.clientY });
  });
  on("dragleave", () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(endDrag, 80); // dragleave fires between child elements too; a following dragover cancels this
  });
  on("drop", (e) => {
    if (!hasFiles(e.dataTransfer) && !e.dataTransfer?.getData?.("text/uri-list")) return;
    e.preventDefault();
    clearTimeout(leaveTimer);
    if (Date.now() - lastNativeDropAt < 500) return; // the native source already handled this drop
    void dropItems(itemsFromDataTransfer(e.dataTransfer!), { x: e.clientX, y: e.clientY });
  });
  on("dragend", () => endDrag());
  on("keydown", (e) => e.key === "Escape" && state().active && endDrag(), true);

  // Tauri: native drag-drop events carry real paths (Finder, Desktop screenshots). The import is lazy: a plain browser never loads it.
  if (typeof window !== "undefined" && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    let off: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((ev) => void handleNativeDrag(ev.payload as NativeDragEvent)))
      .then((un) => (disposed ? un() : (off = un)))
      .catch((err) => console.warn("native drag-drop unavailable", err));
    offs.push(() => ((disposed = true), off?.()));
  }

  // E2E hook: OS-level drags cannot be automated, so a test (or the Tauri e2e harness) injects the same payload the native event carries.
  (window as unknown as { __intelyDrop?: unknown }).__intelyDrop = { native: handleNativeDrag, files: (files: File[], at?: { x: number; y: number }) => dropItems(files.map((f) => itemFromFile(f)), at) };
  offs.push(() => delete (window as unknown as { __intelyDrop?: unknown }).__intelyDrop);

  installed = () => {
    offs.forEach((f) => f());
    installed = undefined;
    endDrag();
  };
  return installed;
}
