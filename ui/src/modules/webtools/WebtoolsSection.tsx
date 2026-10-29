import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { setWebtoolsEnabled, syncWebtoolsEnabled, webtoolsEnabled } from "./toggle";

/** Settings section: the toggle that shows the Web and Node tools and their commands. */
export default function WebtoolsSection() {
  onMount(() => void syncWebtoolsEnabled());
  return (
    <FormGroup title={t("webtools.section.title")} description={t("webtools.section.desc")}>
      <FormRow label={t("webtools.section.enable")} description={t("webtools.section.enableDesc")}>
        <Switch checked={webtoolsEnabled()} onChange={setWebtoolsEnabled} aria-label={t("webtools.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
