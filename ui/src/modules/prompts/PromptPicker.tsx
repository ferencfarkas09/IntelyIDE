import { createMemo, createSignal, onMount } from "solid-js";
import { t } from "../../i18n";
import type { NewRunSlotContext } from "../../platform/newRunSlots";
import { Button, ListChecks, Popover } from "../../ui-kit";
import { fillPrompt, libraryFor } from "./logic";
import { PromptList } from "./PromptList";
import { starterPrompts } from "./starters";
import { currentRepo, loadPrompts, promptContext, promptSettings } from "./store";
import type { ScopedPrompt } from "./types";
import "./prompts.css";

/** Text for the prompt box: the filled prompt alone when the box is empty, else after what is there. */
export const insertInto = (current: string, text: string): string => (current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text);

/** The "Saved prompts" button beside the New Run prompt box: picking one fills its placeholders and puts it into the box. */
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
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-start"
      aria-label={t("prompts.picker")}
      class="prompts-pop"
      trigger={(p) => (
        <Button {...p} size="sm" variant="ghost" icon={ListChecks} disabled={props.ctx.disabled()}>
          {t("prompts.picker")}
        </Button>
      )}
    >
      <PromptList prompts={library()} onPick={(p) => void pick(p)} autofocus />
    </Popover>
  );
}
