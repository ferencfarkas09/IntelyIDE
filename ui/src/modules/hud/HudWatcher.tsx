import { onMount } from "solid-js";
import { startHud } from "./watcher";

/** Overlay: starts the HUD runtime (settings read, Eco clock, tray bridge). Renders nothing. */
export default function HudWatcher() {
  onMount(() => void startHud());
  return null;
}
