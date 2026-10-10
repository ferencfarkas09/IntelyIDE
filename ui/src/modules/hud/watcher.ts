import { createRoot } from "solid-js";
import { ipc } from "../../ipc";
import { setEcoActive } from "../../platform/eco";
import { applyHudSettings, applyTraySettings, hudSettings, traySettings } from "./state";
import { readHud, readTray } from "./logic";
import { startTrayBridge, stopTrayBridge } from "./trayBridge";

// The HUD's runtime. Started once by the overlay; each part runs only while its switch is on.
let started = false;
let offEco: (() => void) | undefined;
let removeFocus: (() => void) | undefined;

async function applyEco(): Promise<void> {
  const { eco, ecoMinutes } = hudSettings();
  const on = eco;
  try {
    await ipc.hud.configure(on, ecoMinutes);
  } catch {
    return;
  }
  if (on && !offEco) {
    offEco = ipc.hud.onEco(setEcoActive);
    const onFocus = () => void ipc.hud.focus(true).catch(() => undefined);
    const onBlur = () => void ipc.hud.focus(false).catch(() => undefined);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    removeFocus = () => (window.removeEventListener("focus", onFocus), window.removeEventListener("blur", onBlur));
    if (typeof document !== "undefined" && !document.hasFocus()) onBlur();
  } else if (!on) {
    offEco?.();
    removeFocus?.();
    offEco = removeFocus = undefined;
    setEcoActive(false);
  }
}

let trayRoot: (() => void) | undefined;
async function applyTray(): Promise<void> {
  const t = traySettings();
  if (t.enabled) {
    trayRoot ??= createRoot((dispose) => (startTrayBridge(), dispose));
  } else if (trayRoot) {
    trayRoot();
    trayRoot = undefined;
    stopTrayBridge();
  }
  try {
    await ipc.tray.configure({ enabled: t.enabled });
  } catch {
    // no tray on this platform: the switch stays, nothing breaks
  }
}

export async function startHud(): Promise<void> {
  if (started) return;
  started = true;
  try {
    applyHudSettings(readHud(await ipc.settings.get("hud")));
    applyTraySettings(readTray(await ipc.settings.get("tray")));
  } catch {
    // defaults: everything off
  }
  await applyEco();
  await applyTray();
  ipc.settings.onChange((e) => {
    if (e.ns === "hud") (applyHudSettings(readHud(e.value as Record<string, unknown>)), void applyEco());
    if (e.ns === "tray") (applyTraySettings(readTray(e.value as Record<string, unknown>)), void applyTray());
  });
}
