import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { runPickerEnabled, setRunPickerEnabled, syncRunPickerEnabled } from "./toggle";

/** Settings section: the toggle that shows the model, effort and ultracode picker in New run. */
export default function RunPickerSection() {
  onMount(() => void syncRunPickerEnabled());
  return (
    <FormGroup title={t("runpicker.section.title")} description={t("runpicker.section.desc")}>
      <FormRow label={t("runpicker.section.enable")} description={t("runpicker.section.enableDesc")}>
        <Switch checked={runPickerEnabled()} onChange={setRunPickerEnabled} aria-label={t("runpicker.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
