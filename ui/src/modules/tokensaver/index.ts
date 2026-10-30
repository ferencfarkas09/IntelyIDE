// Token saver: makes the context cockpit actionable and runs cheaper without making the agent worse. "Tell the agent" beside a
// repeated-read warning, a card that offers a fresh run (and `/compact` where the CLI has it) once the context passes a
// threshold, the share of the cost that is the conversation read again, and optional token-saving habits for Claude runs
// (docs/token-saver.md). A lazy extra that starts switched on, with a Settings toggle; it only adds buttons and lines, and
// sends nothing unless the person asks (or switches "Nudge automatically" on).
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCockpitSlot } from "../../platform/cockpitSlots";
import { registerSettingsSection } from "../../platform/settings";
import { Leaf } from "../../ui-kit";
import { tokenSaverEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  const slot = (id: string, place: "warning" | "context" | "usage", name: "NudgeButton" | "ContextCard" | "CacheShare") =>
    registerCockpitSlot({ id, place, order: 10, component: lazy(async () => ({ default: (await import("./Slots"))[name] })) });
  live = [slot("tokensaver.nudge", "warning", "NudgeButton"), slot("tokensaver.context", "context", "ContextCard"), slot("tokensaver.share", "usage", "CacheShare")];
  void import("./watch").then((m) => {
    if (live.length) live.push(m.startAutoNudge());
  });
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "tokensaver", get title() { return t("tokensaver.section.name"); }, order: 99, icon: Leaf, searchTerms: ["tokens", "cost", "context", "cache", "compact", "nudge", "habits", "save"], component: lazy(() => import("./Section")) });
  createRoot(() => createEffect(() => (tokenSaverEnabled() ? activate() : deactivate())));
}
