import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { setVersionsEnabled, syncVersionsEnabled, versionsEnabled } from "./toggle";

/** Settings section: the toggle that shows the Versions panel and its command. */
export default function VersionsSection() {
  onMount(() => void syncVersionsEnabled());
  return (
    <FormGroup title={t("versions.section.title")} description={t("versions.section.desc")}>
      <FormRow label={t("versions.section.enable")} description={t("versions.section.enableDesc")}>
        <Switch checked={versionsEnabled()} onChange={setVersionsEnabled} aria-label={t("versions.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
