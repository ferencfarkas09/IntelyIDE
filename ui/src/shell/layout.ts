import { createSignal } from "solid-js";
import { readStored, writeStored } from "../ui-kit/storage";

function persistedFlag(key: string, fallback: boolean) {
  const stored = readStored(key);
  const [value, set] = createSignal(stored === null ? fallback : stored === "1");
  return [value, (next: boolean) => (set(next), writeStored(key, next ? "1" : "0"))] as const;
}

/** Commit tool window (left panel) visible. */
export const [panelOpen, setPanelOpen] = persistedFlag("intely.layout.panel", true);
/** Diff preview (centre area) visible next to the tool window. */
export const [diffPreview, setDiffPreview] = persistedFlag("intely.layout.preview", true);

/** The tab of the Commit tool window: the changes tree with the message box, or the stashes. */
export const [commitView, setCommitView] = createSignal<"commit" | "stash">("commit");

/** The centre (editor tabs, diff) never gets narrower than this; the side panels give way first. */
export const CENTRE_MIN = 480;
export const PANEL_MIN = 320;
export const DOCK_MIN = 320;

/** Width of the area next to the rail, measured by the dock host; 0 until it is known (nothing collapses then). */
export const [areaWidth, setAreaWidth] = createSignal(0);

/**
 * Narrow windows collapse the right dock first, then the left panel. The wanted state (`dockOpen`, `panelOpen`) is
 * kept, so widening the window brings both back, and the rail buttons show what is really on screen.
 */
export const panelVisible = (): boolean => panelOpen() && (areaWidth() <= 0 || areaWidth() >= CENTRE_MIN + PANEL_MIN);
export const dockFits = (): boolean => areaWidth() <= 0 || areaWidth() >= CENTRE_MIN + (panelVisible() ? PANEL_MIN : 0) + DOCK_MIN;
