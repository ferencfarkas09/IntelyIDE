import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { nightQueueEnabled, setNightQueueEnabled, syncNightQueue } from "./toggle";

/** Settings section: the toggle that loads the night queue and the Morning brief. */
export default function BriefSection() {
  onMount(() => void syncNightQueue());
  return (
    <FormGroup title={t("night.section.title")} description={t("night.section.desc")}>
      <FormRow label={t("night.section.enable")} description={t("night.section.enableDesc")}>
        <Switch checked={nightQueueEnabled()} onChange={setNightQueueEnabled} aria-label={t("night.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
