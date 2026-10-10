// One line per feature module. A module is a folder with an index.ts exporting `register()`; it adds its pieces to the
// platform registries (rail, tabs, commands, settings, status bar, editor extensions) and nothing else. Only the owner of
// the module edits its folder; this file is complete and never changes when a module grows.
import { register as attachments } from "./attachments";
import { register as branches } from "./branches";
import { register as brief } from "./brief";
import { register as checks } from "./checks";
import { register as contract } from "./contract";
import { register as editor } from "./editor";
import { register as graph } from "./graph";
import { register as happyChat } from "./happy-chat";
import { register as happyMeet } from "./happy-meet";
import { register as happyNotifications } from "./happy-notifications";
import { register as happyTasks } from "./happy-tasks";
import { register as happyTimer } from "./happy-timer";
import { register as history } from "./history";
import { register as hud } from "./hud";
import { register as notify } from "./notify";
import { register as hygiene } from "./hygiene";
import { register as inspector } from "./inspector";
import { register as integrations } from "./integrations";
import { register as mcp } from "./mcp";
import { register as mongo } from "./mongo";
import { register as l10n } from "./l10n";
import { register as licenses } from "./licenses";
import { register as pr } from "./pr";
import { register as preview } from "./preview";
import { register as previewInspect } from "./preview-inspect";
import { register as providers } from "./providers";
import { register as release } from "./release";
import { register as remote } from "./remote";
import { register as roles } from "./roles";
import { register as run } from "./run";
import { register as runs } from "./runs";
import { register as search } from "./search";
import { register as sentry } from "./sentry";
import { register as settingsCore } from "./settings-core";
import { register as terminal } from "./terminal";
import { register as updates } from "./updates";
import { register as usage } from "./usage";
import { register as viewers } from "./viewers";

export interface FeatureModule {
  id: string;
  register: () => void;
}

export const MODULES: readonly FeatureModule[] = [
  { id: "editor", register: editor },
  { id: "terminal", register: terminal },
  { id: "search", register: search },
  { id: "branches", register: branches },
  { id: "graph", register: graph },
  { id: "roles", register: roles },
  { id: "runs", register: runs },
  { id: "run", register: run },
  { id: "inspector", register: inspector },
  { id: "settings-core", register: settingsCore },
  { id: "providers", register: providers },
  { id: "mcp", register: mcp },
  { id: "integrations", register: integrations },
  { id: "mongo", register: mongo },
  { id: "happy-timer", register: happyTimer },
  { id: "happy-meet", register: happyMeet },
  { id: "happy-notifications", register: happyNotifications },
  { id: "happy-tasks", register: happyTasks },
  { id: "happy-chat", register: happyChat },
  { id: "attachments", register: attachments },
  { id: "preview", register: preview },
  { id: "preview-inspect", register: previewInspect },
  { id: "l10n", register: l10n },
  { id: "release", register: release },
  { id: "remote", register: remote },
  { id: "viewers", register: viewers },
  { id: "hud", register: hud },
  { id: "notify", register: notify },
  { id: "checks", register: checks },
  { id: "hygiene", register: hygiene },
  { id: "contract", register: contract },
  { id: "pr", register: pr },
  { id: "history", register: history },
  { id: "brief", register: brief },
  { id: "licenses", register: licenses },
  { id: "updates", register: updates },
  { id: "usage", register: usage },
  { id: "sentry", register: sentry },
];

/** Runs every module's `register()`. A module that throws is logged and skipped: the app and the other modules start anyway. */
export function registerModules(modules: readonly FeatureModule[] = MODULES): { id: string; error: unknown }[] {
  const failed: { id: string; error: unknown }[] = [];
  for (const m of modules) {
    try {
      m.register();
    } catch (error) {
      console.error(`Module "${m.id}" failed to register`, error);
      failed.push({ id: m.id, error });
    }
  }
  return failed;
}
