import { onCleanup } from "solid-js";
import { registerModules } from "../modules";
import { registerBuiltins } from "../shell/builtin";
import { Shell } from "../shell/Shell";
import { startWorkspaces } from "../store/workspaces";
import { startWorkspaceUiSync } from "../store/workspaceUi";
import { initTheme, setThemePreference } from "../ui-kit";

/** `?theme=dark|light|system` pins the theme for screenshots and manual checks (and is remembered like a menu choice). */
function themeFromUrl(): "dark" | "light" | "system" | null {
  const value = new URLSearchParams(globalThis.location?.search).get("theme");
  return value === "dark" || value === "light" || value === "system" ? value : null;
}

export function App() {
  initTheme();
  registerBuiltins();
  registerModules();
  const forced = themeFromUrl();
  if (forced) setThemePreference(forced);
  onCleanup(startWorkspaces());
  onCleanup(startWorkspaceUiSync());
  return <Shell />;
}
