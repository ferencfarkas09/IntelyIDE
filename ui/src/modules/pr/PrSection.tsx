import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { prEnabled, setPrEnabled, syncPrEnabled } from "./toggle";

/** Settings section: the toggle that loads the pull request tab. */
export default function PrSection() {
  onMount(() => void syncPrEnabled());
  return (
    <FormGroup title={t("pr.section.title")} description={t("pr.section.desc")}>
      <FormRow label={t("pr.section.enable")} description={t("pr.section.enableDesc")}>
        <Switch checked={prEnabled()} onChange={setPrEnabled} aria-label={t("pr.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
