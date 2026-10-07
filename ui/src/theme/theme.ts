import { createSignal, type Accessor } from "solid-js";
import { defaultStorage, readStored, writeStored, type KeyValueStorage } from "../ui-kit/storage";
import { applyStoredAccent } from "./accents";

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "intely.theme";

export function parsePreference(raw: unknown): ThemePreference {
  return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** Injectable environment so the controller is testable without a DOM. */
export interface ThemeEnv {
  storage: KeyValueStorage | null;
  root: { setAttribute(name: string, value: string): void } | null;
  media: {
    matches: boolean;
    addEventListener(type: "change", cb: (e: { matches: boolean }) => void): void;
    removeEventListener(type: "change", cb: (e: { matches: boolean }) => void): void;
  } | null;
}

export interface ThemeController {
  preference: Accessor<ThemePreference>;
  resolved: Accessor<ResolvedTheme>;
  setPreference(pref: ThemePreference): void;
  /** system -> dark -> light -> system */
  cycle(): void;
  dispose(): void;
}

function browserEnv(): ThemeEnv {
  const hasDom = typeof document !== "undefined";
  return {
    storage: defaultStorage(),
    root: hasDom ? document.documentElement : null,
    media: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null,
  };
}

export function createThemeController(env: ThemeEnv = browserEnv()): ThemeController {
  const [preference, setPref] = createSignal<ThemePreference>(parsePreference(readStored(THEME_STORAGE_KEY, env.storage)));
  // No media query available (SSR, tests): the app default is dark.
  const [systemDark, setSystemDark] = createSignal(env.media ? env.media.matches : true);
  const resolved = () => resolveTheme(preference(), systemDark());

  const apply = () => {
    env.root?.setAttribute("data-theme", resolved());
    env.root?.setAttribute("data-theme-pref", preference());
  };
  const onChange = (e: { matches: boolean }) => {
    setSystemDark(e.matches);
    apply();
  };
  env.media?.addEventListener("change", onChange);
  apply();

  const setPreference = (pref: ThemePreference) => {
    setPref(pref);
    writeStored(THEME_STORAGE_KEY, pref, env.storage);
    apply();
  };

  return {
    preference,
    resolved,
    setPreference,
    cycle() {
      const order: ThemePreference[] = ["system", "dark", "light"];
      setPreference(order[(order.indexOf(preference()) + 1) % order.length]);
    },
    dispose() {
      env.media?.removeEventListener("change", onChange);
    },
  };
}

let shared: ThemeController | undefined;

/** The app-wide controller. Call once before the first render to avoid a theme flash. */
export function initTheme(): ThemeController {
  // The accent comes from the localStorage mirror in the same synchronous step, so the first paint already has it.
  if (!shared) applyStoredAccent();
  return (shared ??= createThemeController());
}

export const themePreference = () => initTheme().preference();
export const resolvedTheme = () => initTheme().resolved();
export const setThemePreference = (pref: ThemePreference) => initTheme().setPreference(pref);
