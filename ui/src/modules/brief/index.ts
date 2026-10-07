// Night queue and Morning brief (Wave 4, backlog #6): runs prepared in the evening (role, prompt, repos, per-run time
// and token budget, a hard cap per night) that start one at a time through the normal run path (process gate, write
// lease, Rewind snapshot first), stop on budget, never commit or push, and pause on battery and in read-only mode; and a
// brief the next morning from the event logs and git. A lazy extra with a Settings toggle: while it is off only the
// Settings section exists, nothing is loaded, polled or drawn, and the backend queue stays idle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { Moon, Sun } from "../../ui-kit";
import { openNight } from "./open";
import { nightQueueEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "nightqueue", get title() { return t("night.name"); }, icon: Moon, component: lazy(() => import("./NightTab")), canClose: true }),
    registerCommand({ id: "night.queue", get title() { return t("night.cmd.queue"); }, get group() { return t("group.agents"); }, keywords: ["night", "overnight", "queue", "unattended", "budget", "schedule"], run: () => void openNight("queue") }),
    registerCommand({ id: "night.brief", get title() { return t("night.cmd.brief"); }, get group() { return t("group.agents"); }, keywords: ["morning", "brief", "summary", "overnight", "what changed", "review"], run: () => void openNight("brief") }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "night", get title() { return t("night.section.name"); }, order: 99, icon: Sun, searchTerms: ["night", "overnight", "queue", "morning", "brief", "budget", "unattended"], component: lazy(() => import("./BriefSection")) });
  createRoot(() => createEffect(() => (nightQueueEnabled() ? activate() : deactivate())));
}
