import { createMemo, createSignal } from "solid-js";
import { t } from "../../i18n";
import { requestNewRun } from "../../platform/newRun";
import { Dialog, toast } from "../../ui-kit";
import { fillPrompt, libraryFor } from "./logic";
import { PromptList } from "./PromptList";
import { starterPrompts } from "./starters";
import { currentRepo, loadPrompts, promptContext, promptSettings } from "./store";
import type { ScopedPrompt } from "./types";
import "./prompts.css";

const [open, setOpen] = createSignal(false);

/** The palette command "Run a saved prompt...": the library opens; a pick goes to the New Run dialog, filled in. */
export async function openRunPrompt(): Promise<void> {
  await loadPrompts();
  setOpen(true);
}

/** Overlay: one list of every prompt for the current repository. Nothing runs before Start run in the New Run dialog. */
export default function RunPromptDialog() {
  const repoId = createMemo(() => currentRepo());
  const library = createMemo(() => libraryFor(promptSettings(), repoId() ? [repoId()!] : [], starterPrompts()));
  const pick = async (p: ScopedPrompt) => {
    setOpen(false);
    const repo = p.scope.kind === "repo" ? p.scope.repoId : repoId();
    const prompt = fillPrompt(p.body, await promptContext(repo));
    if (!(await requestNewRun({ prompt, repoIds: repo ? [repo] : undefined }))) toast.warn(t("prompts.noDialog"));
  };
  return (
    <Dialog open={open()} onClose={() => setOpen(false)} size="md" title={t("prompts.run.title")} description={t("prompts.run.desc")}>
      <PromptList prompts={library()} onPick={(p) => void pick(p)} autofocus class="prompts-list--dialog" />
    </Dialog>
  );
}
