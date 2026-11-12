// Prompt library: the person's own prompts (for every repository or for one), seeded read-only starters for the usual
// stacks, placeholders filled from the editor and the repository, a picker in the New Run dialog and a palette command.
// Stored in settings.json, never in a repository. A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerNewRunSlot } from "../../platform/newRunSlots";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { ListChecks } from "../../ui-kit";
import { openPrompts } from "./open";
import { promptsEnabled } from "./toggle";

let live: (() => void)[] = [];
const dialog = () => import("./RunPromptDialog");

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "prompts", get title() { return t("prompts.name"); }, icon: ListChecks, component: lazy(() => import("./PromptsTab")), canClose: true }),
    registerNewRunSlot({ id: "prompts.picker", place: "prompt", order: 10, component: lazy(() => import("./PromptPicker")) }),
    registerOverlay({ id: "prompts.run", component: lazy(dialog) }),
    registerCommand({ id: "prompts.run", get title() { return t("prompts.cmd.run"); }, get group() { return t("prompts.name"); }, keywords: ["prompt", "template", "snippet", "saved", "library", "run"], run: async () => void (await dialog()).openRunPrompt() }),
    registerCommand({ id: "prompts.open", get title() { return t("prompts.cmd.open"); }, get group() { return t("prompts.name"); }, keywords: ["prompt", "template", "library", "import", "export"], run: () => void openPrompts() }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "prompts", get title() { return t("prompts.section.name"); }, order: 122, icon: ListChecks, searchTerms: ["prompt", "template", "library", "snippet", "starter"], component: lazy(() => import("./PromptsSection")) });
  createRoot(() => createEffect(() => (promptsEnabled() ? activate() : deactivate())));
}
