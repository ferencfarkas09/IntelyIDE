import { createSignal } from "solid-js";
import { DEFAULT_HUD, DEFAULT_TRAY, type HudSettings, type TraySettings } from "./logic";

// Shared by the watcher (writes), the chip and the settings page (read). Defaults are "off": nothing starts until a switch is on.
const [hud, setHud] = createSignal<HudSettings>(DEFAULT_HUD);
const [tray, setTray] = createSignal<TraySettings>(DEFAULT_TRAY);

export const hudSettings = hud;
export const traySettings = tray;
export const applyHudSettings = setHud;
export const applyTraySettings = setTray;
export const hudVisible = (): boolean => hud().enabled;
