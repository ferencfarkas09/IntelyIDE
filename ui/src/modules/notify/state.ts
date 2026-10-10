import { createSignal } from "solid-js";
import { DEFAULT_NOTIFY, type NotifySettings } from "./logic";

// Shared by the watcher (reads) and the settings page (writes). The defaults are on: a run that needs you should be heard.
const [settings, setSettings] = createSignal<NotifySettings>(DEFAULT_NOTIFY);

export const notifySettings = settings;
export const applyNotifySettings = setSettings;
