import { createMemo, createSignal, For, onMount } from "solid-js";
import { t } from "../../i18n";
import type { NewRunSlotContext } from "../../platform/newRunSlots";
import { Chip, Popover } from "../../ui-kit";
import { fillPrompt, libraryFor } from "./logic";
import { PromptList } from "./PromptList";
import { starterPrompts } from "./starters";
import { currentRepo, loadPrompts, promptContext, promptSettings } from "./store";
import type { ScopedPrompt } from "./types";
import "./prompts.css";

/** Text for the prompt box: the filled prompt alone when the box is empty, else after what is there. */
export const insertInto = (current: string, text: string): string => (current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text);

/** How many prompts sit under the prompt box as chips; the rest are in the list behind "All prompts". */
export const QUICK_PROMPTS = 3;

/** "Saved prompts" under the New Run prompt box: the first ones as chips and the whole list behind "All prompts". Picking one fills its placeholders and puts it into the box. */
export default function PromptPicker(props: { ctx: NewRunSlotContext }) {
  const [open, setOpen] = createSignal(false);
  onMount(() => void loadPrompts());
  const library = createMemo(() => libraryFor(promptSettings(), props.ctx.repoIds(), starterPrompts()));
  const pick = async (p: ScopedPrompt) => {
    setOpen(false);
    const repoId = p.scope.kind === "repo" ? p.scope.repoId : (props.ctx.repoIds()[0] ?? currentRepo());
    const text = fillPrompt(p.body, await promptContext(repoId));
    props.ctx.setPrompt(insertInto(props.ctx.prompt(), text));
  };
  return (
    <div class="newrun__field prompt-chips" role="group" aria-label={t("prompts.picker")}>
      <span class="newrun__label" data-minor="">{t("prompts.picker")}</span>
      <div class="prompt-chips__row">
        <For each={library().slice(0, QUICK_PROMPTS)}>
          {(p) => (
            <Chip title={p.title} disabled={props.ctx.disabled()} onClick={() => void pick(p)}>
              {p.title}
            </Chip>
          )}
        </For>
        <Popover
          open={open()}
          onOpenChange={setOpen}
          placement="bottom-start"
          aria-label={t("prompts.picker")}
          class="prompts-pop"
          trigger={(p) => (
            <Chip {...p} dashed disabled={props.ctx.disabled()}>
              {t("prompts.all")}
            </Chip>
          )}
        >
          <PromptList prompts={library()} onPick={(p) => void pick(p)} autofocus />
        </Popover>
      </div>
    </div>
  );
}
