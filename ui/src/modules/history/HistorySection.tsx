import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { sessionSearchEnabled, setSessionSearchEnabled, syncSessionSearch } from "./toggle";

/** Settings section: the toggle that loads the session search and the context cockpit. */
export default function HistorySection() {
  onMount(() => void syncSessionSearch());
  return (
    <FormGroup title={t("history.section.title")} description={t("history.section.desc")}>
      <FormRow label={t("history.section.enable")} description={t("history.section.enableDesc")}>
        <Switch checked={sessionSearchEnabled()} onChange={setSessionSearchEnabled} aria-label={t("history.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
