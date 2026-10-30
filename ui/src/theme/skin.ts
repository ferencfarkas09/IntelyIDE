/**
 * The skin axis: `data-skin` on <html> ("standard" | "glass"), independent of `data-theme` and `data-accent`, plus the
 * manual "Reduce transparency" switch (`data-transparency="reduced"`). glass.css holds the tokens; this file only sets the
 * attributes and exposes one signal that canvases (xterm, the lane graph, CodeMirror) watch to repaint.
 */
import { createSignal } from "solid-js";
import { defaultStorage, type KeyValueStorage } from "../ui-kit/storage";
import { resolvedTheme } from "./theme";

export type Skin = "standard" | "glass";
export const SKINS: readonly Skin[] = ["standard", "glass"];

export function parseSkin(raw: unknown): Skin | null {
  return raw === "standard" || raw === "glass" ? raw : null;
}

const [skin, setSkin] = createSignal<Skin>("standard");
const [reduced, setReduced] = createSignal(false);
/** `?skin=` pins the skin for screenshots and manual checks; the stored choice is still saved, just not shown. */
let pinned: Skin | null = null;
let manualReduced = false;
let lastRoot: Root | null = null;

/** OS settings that ask for opaque surfaces. Any of them turns Glass into its opaque variant, like the manual switch. */
export const OPAQUE_QUERIES = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"] as const;

type Media = Pick<MediaQueryList, "matches" | "addEventListener">;
let medias: Media[] | null = null;
function systemMedias(): Media[] {
  if (medias) return medias;
  medias = typeof matchMedia === "function" ? OPAQUE_QUERIES.map((q) => matchMedia(q)) : [];
  medias.forEach((m) => m.addEventListener?.("change", () => paint(lastRoot)));
  return medias;
}

/**
 * macOS "Reduce transparency", asked from the host: WKWebView has no `prefers-reduced-transparency`, so the media queries
 * above stay false there. Unknown (not asked yet, the browser mock, another OS) is false.
 */
let hostReduced = false;
let hostAsked: Promise<boolean> | null = null;

/** Asks the host once (it answers false off macOS) and repaints if the answer changes anything. Never rejects. */
export function loadHostTransparency(ask: () => Promise<boolean> = askHost): Promise<boolean> {
  hostAsked ??= ask().then(
    (v) => {
      hostReduced = v === true;
      if (hostReduced) paint(lastRoot);
      return hostReduced;
    },
    () => false,
  );
  return hostAsked;
}

async function askHost(): Promise<boolean> {
  if (typeof window === "undefined" || !(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("os_reduce_transparency");
}

/** True while the OS asks for less transparency or more contrast (media queries, plus the host's macOS flag). */
export const systemWantsOpaque = (): boolean => hostReduced || systemMedias().some((m) => m.matches);

export const activeSkin = skin;
/** True while Glass is drawn opaque (the switch in Settings or the OS asks for it). */
export const transparencyReduced = reduced;

/** One key per visual variant: effects that paint from tokens (canvas, xterm) depend on it to follow every switch. */
export const appearanceLook = (): string => `${resolvedTheme()}|${skin()}|${reduced() ? "opaque" : "clear"}`;

type Root = Pick<HTMLElement, "setAttribute" | "removeAttribute">;
const docRoot = (): Root | null => (typeof document === "undefined" ? null : document.documentElement);

function paint(root: Root | null): void {
  const opaque = manualReduced || systemWantsOpaque();
  setReduced(opaque);
  if (!root) return;
  root.setAttribute("data-skin", skin());
  if (opaque) root.setAttribute("data-transparency", "reduced");
  else root.removeAttribute("data-transparency");
}

/** Sets `data-skin` and `data-transparency`. Cheap and idempotent. */
export function applySkin(next: Skin, reduceTransparency: boolean, root: Root | null = docRoot()): void {
  setSkin(pinned ?? next);
  manualReduced = reduceTransparency;
  lastRoot = root;
  paint(root);
}

/**
 * Reads `?skin=standard|glass` and shows it. With `pin` (the app) the stored choice cannot replace it during this page load;
 * without (the kit gallery) the page's own switch still works. Returns the skin from the URL, if any.
 */
export function pinSkinFromUrl(search: string = globalThis.location?.search ?? "", root: Root | null = docRoot(), pin = true): Skin | null {
  const s = parseSkin(new URLSearchParams(search).get("skin"));
  if (!s) return null;
  if (pin) pinned = s;
  applySkin(s, manualReduced, root);
  return s;
}

/** Test hook. */
export function resetSkinForTests(): void {
  pinned = null;
  manualReduced = false;
  lastRoot = null;
  medias = null;
  hostReduced = false;
  hostAsked = null;
  setSkin("standard");
  setReduced(false);
}

/**
 * Whether this browser profile has been used by IntelyIDE before: any `intely.*` key in localStorage. Read before anything
 * of this boot writes there, it tells a new install (Glass by default) from an update (keeps Standard) at first paint.
 */
export function hasLocalHistory(storage: (KeyValueStorage & { length?: number; key?(i: number): string | null }) | null = defaultStorage()): boolean {
  try {
    const n = storage?.length ?? 0;
    for (let i = 0; i < n; i++) if (storage?.key?.(i)?.startsWith("intely.")) return true;
  } catch {
    /* blocked storage: treat as used, the safe side keeps the familiar look */
    return true;
  }
  return false;
}

/** Taken when this module loads, i.e. before any feature module registers and writes keys of its own. */
const bootHistory = hasLocalHistory();
export const localHistoryAtBoot = (): boolean => bootHistory;

/**
 * The skin for an install whose settings have no `skin` yet. Owner decision: Glass is the default for new installs only;
 * anything that shows earlier use (local history, other appearance choices, a known workspace) keeps Standard, and so does an
 * OS that asks for less transparency or more contrast (Glass would only be its opaque variant there).
 */
export function defaultSkin(signals: { localHistory: boolean; appearanceKeys: number; workspaces: number; systemOpaque?: boolean }): Skin {
  return signals.localHistory || signals.appearanceKeys > 0 || signals.workspaces > 0 || signals.systemOpaque ? "standard" : "glass";
}
