import { onMount } from "solid-js";
import { startNotify } from "./watcher";

/** Overlay: starts the run notifications (settings read, banners, Dock badge). Renders nothing. */
export default function NotifyWatcher() {
  onMount(() => void startNotify());
  return null;
}
