import { readStored, writeStored } from "../../ui-kit/storage";
import { APPEARANCE_MIRROR_KEY, applyAccent } from "../../theme/accents";
import { applySkin, defaultSkin, hasLocalHistory, loadHostTransparency, localHistoryAtBoot, parseSkin, systemWantsOpaque, type Skin } from "../../theme/skin";
import type { SettingsValue } from "../../ipc/settings";
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearanceSettings } from "./model";
import "./appearance.css";

/** Mirror of the appearance settings so the first paint already has them; settings.json stays the source of truth. */
export const APPEARANCE_STORAGE_KEY = APPEARANCE_MIRROR_KEY;

/** The type scale follows the base size: the kit's 11/12/13/14 steps keep their distance. */
export function fontVars(a: Pick<AppearanceSettings, "uiFontSize" | "codeFontSize">): Record<string, string> {
  const base = a.uiFontSize;
  return {
    "--text-xs": `${base - 2}px`,
    "--text-sm": `${base - 1}px`,
    "--text-base": `${base}px`,
    "--text-md": `${base + 1}px`,
    "--code-font-size": `${a.codeFontSize}px`,
  };
}

export function applyAppearance(a: AppearanceSettings, root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): void {
  if (!root) return;
  root.dataset.density = a.density;
  applyAccent(a.accent, a.customAccent);
  applySkin(a.skin, a.reduceTransparency);
  Object.entries(fontVars(a)).forEach(([name, value]) => root.style.setProperty(name, value));
}

export function readMirror(): AppearanceSettings {
  try {
    return normalizeAppearance(JSON.parse(readStored(APPEARANCE_STORAGE_KEY) ?? "{}"));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveMirror(a: AppearanceSettings): void {
  writeStored(APPEARANCE_STORAGE_KEY, JSON.stringify(a));
}

function rawMirror(): SettingsValue {
  try {
    const raw = JSON.parse(readStored(APPEARANCE_STORAGE_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Did this profile run IntelyIDE before? The snapshot from before this boot wrote anything (tests read it live). */
let localHistory: boolean | undefined;
let liveHistory = false;
const history = (): boolean => (localHistory ??= liveHistory ? hasLocalHistory() : localHistoryAtBoot());

/**
 * Synchronous and cheap: reads localStorage, sets attributes and CSS variables. Called from `register()`.
 * A mirror without a skin is either a new install (Glass) or one from before Glass (Standard); `settleSkin` makes it final.
 */
export function applyStoredAppearance(): void {
  const raw = rawMirror();
  const a = normalizeAppearance(raw);
  if (!parseSkin(raw.skin)) a.skin = defaultSkin({ localHistory: history(), appearanceKeys: Object.keys(raw).length, workspaces: 0, systemOpaque: systemWantsOpaque() });
  applyAppearance(a);
}

export interface SettleDeps {
  read(): Promise<SettingsValue>;
  write(patch: SettingsValue): Promise<unknown>;
  /** Resolves with the number of known workspaces once the registry has answered. */
  workspaces(): Promise<number>;
}

/**
 * Makes the skin choice durable once per install. settings.json is the source of truth: a stored skin wins; without one
 * the install is judged once (no local history, no other appearance choice, no workspace = new = Glass) and the verdict is
 * written, so later boots never guess again. Never throws.
 */
export async function settleSkin(deps: SettleDeps): Promise<Skin> {
  let raw: SettingsValue = {};
  void loadHostTransparency();
  try {
    raw = await deps.read();
  } catch {
    /* settings unavailable: judge from the local signals */
  }
  let skin = parseSkin(raw.skin);
  if (!skin) {
    const workspaces = await deps.workspaces().catch(() => 1);
    // The person may have picked a style while the registry was loading: that choice wins.
    raw = await deps.read().catch(() => raw);
    skin = parseSkin(raw.skin);
    if (!skin) {
      await loadHostTransparency();
      skin = defaultSkin({ localHistory: history(), appearanceKeys: Object.keys(raw).length, workspaces, systemOpaque: systemWantsOpaque() });
      await deps.write({ skin }).catch(() => {});
    }
  }
  const next = { ...normalizeAppearance({ ...rawMirror(), ...raw }), skin };
  applyAppearance(next);
  saveMirror(next);
  return skin;
}

/** Test hook: forget the verdict and read localStorage live from now on. */
export function resetLocalHistoryForTests(): void {
  localHistory = undefined;
  liveHistory = true;
}
