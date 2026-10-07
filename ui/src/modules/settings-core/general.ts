import { readStored, writeStored } from "../../ui-kit/storage";
import { setFocusRefresh } from "../../store/workspace";
import { setLocale } from "../../i18n";
import type { SettingsValue } from "../../ipc/settings";
import type { GeneralSettings } from "./model";

/** localStorage copy of the setting the app needs before Settings was ever opened (the language has its own key in i18n). */
export const FOCUS_REFRESH_KEY = "intely.fetchOnFocus";

export function applyGeneral(g: GeneralSettings, raw?: SettingsValue): void {
  // A language that was never chosen stays on the automatic one (browser language on first run).
  if (!raw || raw.language !== undefined) void setLocale(g.language);
  setFocusRefresh(g.fetchOnFocus);
  writeStored(FOCUS_REFRESH_KEY, g.fetchOnFocus ? "1" : "0");
}

/** Synchronous and cheap, for `register()`: the language is restored by i18n itself, the focus refresh from its mirror. */
export function applyStoredGeneral(): void {
  setFocusRefresh(readStored(FOCUS_REFRESH_KEY) !== "0");
}
