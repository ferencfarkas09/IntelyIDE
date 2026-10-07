import { readStored, writeStored } from "../../ui-kit/storage";
import { APPEARANCE_MIRROR_KEY, applyAccent } from "../../theme/accents";
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

/** Synchronous and cheap: reads localStorage, sets attributes and CSS variables. Called from `register()`. */
export function applyStoredAppearance(): void {
  applyAppearance(readMirror());
}
