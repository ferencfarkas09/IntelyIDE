import { onCleanup, onMount } from "solid-js";
import { startHappyWatch } from "../../store/happy";

/** Mounted once under the shell. Reads the Happy settings (no Keychain, no network) and wires the events only while the integrations are on. */
export default function Watcher() {
  onMount(() => onCleanup(startHappyWatch()));
  return null;
}
