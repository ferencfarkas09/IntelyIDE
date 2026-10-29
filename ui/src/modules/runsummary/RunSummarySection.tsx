import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { runSummaryEnabled, setRunSummaryEnabled, syncRunSummaryEnabled } from "./toggle";

/** Settings section: the toggle that shows the run summary card, the chip on run cards and the palette command. */
export default function RunSummarySection() {
  onMount(() => void syncRunSummaryEnabled());
  return (
    <FormGroup title={t("runsummary.section.title")} description={t("runsummary.section.desc")}>
      <FormRow label={t("runsummary.section.enable")} description={t("runsummary.section.enableDesc")}>
        <Switch checked={runSummaryEnabled()} onChange={setRunSummaryEnabled} aria-label={t("runsummary.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
