import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { releaseEnabled, setReleaseEnabled, syncReleaseEnabled } from "./toggle";

/** Settings section: the toggle that loads the changelog and release assistant. */
export default function ReleaseSection() {
  onMount(() => void syncReleaseEnabled());
  return (
    <FormGroup title={t("release.section.title")} description={t("release.section.desc")}>
      <FormRow label={t("release.section.enable")} description={t("release.section.enableDesc")}>
        <Switch checked={releaseEnabled()} onChange={setReleaseEnabled} aria-label={t("release.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
