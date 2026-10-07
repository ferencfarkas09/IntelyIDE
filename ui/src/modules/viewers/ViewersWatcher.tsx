import { onMount } from "solid-js";
import { watchViewerSettings } from "./state";

/** Overlay: reads the Settings switch once. Renders nothing. */
export default function ViewersWatcher() {
  onMount(() => void watchViewerSettings());
  return null;
}
