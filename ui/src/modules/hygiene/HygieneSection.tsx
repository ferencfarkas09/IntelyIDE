import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { hygieneEnabled, setHygieneEnabled, syncHygieneEnabled } from "./toggle";

/** Settings section: the toggle that loads branch hygiene and the worktree manager. */
export default function HygieneSection() {
  onMount(() => void syncHygieneEnabled());
  return (
    <FormGroup title={t("hygiene.section.title")} description={t("hygiene.section.desc")}>
      <FormRow label={t("hygiene.section.enable")} description={t("hygiene.section.enableDesc")}>
        <Switch checked={hygieneEnabled()} onChange={setHygieneEnabled} aria-label={t("hygiene.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
