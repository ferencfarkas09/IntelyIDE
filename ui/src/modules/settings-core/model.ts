import type { SettingsValue } from "../../ipc/settings";
import { isSupported, type Locale } from "../../i18n";
import { ACCENT_IDS, CUSTOM_ACCENT, normalizeHex } from "../../theme/accents";
import type { ThemePreference } from "../../ui-kit";

/** Namespaces of settings.json owned by this module. The editor module reads `editor` through `ipc.settings`. */
export const NS = { general: "general", appearance: "appearance", editor: "editor" } as const;

export interface GeneralSettings {
  language: Locale;
  /** Refresh every repo's status when the window gets focus (the git fetch itself stays manual). */
  fetchOnFocus: boolean;
}

export type Density = "comfortable" | "compact";
/** A preset family id (`violet`, `indigo`, ...) or `custom`; the colour of `custom` is `customAccent`. */
export type Accent = string;

export interface AppearanceSettings {
  theme: ThemePreference;
  accent: Accent;
  /** `#rrggbb` the user picked; only used while `accent` is `custom`. */
  customAccent: string;
  density: Density;
  uiFontSize: number;
  codeFontSize: number;
}

export interface EditorSettings {
  tabSize: 2 | 4 | 8;
  softWrap: boolean;
  lineNumbers: boolean;
  /** Placeholder until a formatter exists; stored so the choice survives. */
  formatOnSave: boolean;
}

export const FONT_LIMITS = { ui: { min: 11, max: 16 }, code: { min: 10, max: 18 } } as const;

export const DEFAULT_GENERAL: GeneralSettings = { language: "en", fetchOnFocus: true };
export const DEFAULT_APPEARANCE: AppearanceSettings = { theme: "system", accent: "violet", customAccent: "#2a9d8f", density: "comfortable", uiFontSize: 13, codeFontSize: 12 };
export const DEFAULT_EDITOR: EditorSettings = { tabSize: 4, softWrap: false, lineNumbers: true, formatOnSave: false };

const oneOf = <T,>(raw: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(raw as T) ? (raw as T) : fallback);
const bool = (raw: unknown, fallback: boolean) => (typeof raw === "boolean" ? raw : fallback);
const size = (raw: unknown, { min, max }: { min: number; max: number }, fallback: number) =>
  typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : fallback;

/** settings.json is hand-editable: junk or missing values fall back to the defaults instead of breaking the UI. */
export function normalizeGeneral(raw: SettingsValue): GeneralSettings {
  return { language: isSupported(raw.language) ? raw.language : DEFAULT_GENERAL.language, fetchOnFocus: bool(raw.fetchOnFocus, DEFAULT_GENERAL.fetchOnFocus) };
}

export function normalizeAppearance(raw: SettingsValue): AppearanceSettings {
  return {
    theme: oneOf(raw.theme, ["system", "dark", "light"], DEFAULT_APPEARANCE.theme),
    accent: oneOf(raw.accent, [...ACCENT_IDS, CUSTOM_ACCENT], DEFAULT_APPEARANCE.accent),
    customAccent: (typeof raw.customAccent === "string" && normalizeHex(raw.customAccent)) || DEFAULT_APPEARANCE.customAccent,
    density: oneOf(raw.density, ["comfortable", "compact"], DEFAULT_APPEARANCE.density),
    uiFontSize: size(raw.uiFontSize, FONT_LIMITS.ui, DEFAULT_APPEARANCE.uiFontSize),
    codeFontSize: size(raw.codeFontSize, FONT_LIMITS.code, DEFAULT_APPEARANCE.codeFontSize),
  };
}

export function normalizeEditor(raw: SettingsValue): EditorSettings {
  return {
    tabSize: oneOf(raw.tabSize, [2, 4, 8], DEFAULT_EDITOR.tabSize),
    softWrap: bool(raw.softWrap, DEFAULT_EDITOR.softWrap),
    lineNumbers: bool(raw.lineNumbers, DEFAULT_EDITOR.lineNumbers),
    formatOnSave: bool(raw.formatOnSave, DEFAULT_EDITOR.formatOnSave),
  };
}
