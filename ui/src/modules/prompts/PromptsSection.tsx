import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { promptsEnabled, setPromptsEnabled, syncPromptsEnabled } from "./toggle";

/** Settings section: the toggle that shows the prompt library, its picker and its commands. */
export default function PromptsSection() {
  onMount(() => void syncPromptsEnabled());
  return (
    <FormGroup title={t("prompts.section.title")} description={t("prompts.section.desc")}>
      <FormRow label={t("prompts.section.enable")} description={t("prompts.section.enableDesc")}>
        <Switch checked={promptsEnabled()} onChange={setPromptsEnabled} aria-label={t("prompts.section.enable")} />
      </FormRow>
    </FormGroup>
  );
}
