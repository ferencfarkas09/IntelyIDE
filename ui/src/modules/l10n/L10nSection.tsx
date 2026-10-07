import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { l10nEnabled, setL10nEnabled, syncL10nEnabled } from "./toggle";

/** Settings section: the toggle that loads the localization checker (nothing of it runs while it is off). */
export default function L10nSection() {
  onMount(() => void syncL10nEnabled());
  return (
    <FormGroup title={t("l10n.section.title")} description={t("l10n.section.desc")}>
      <FormRow label={t("l10n.section.enable")} description={t("l10n.section.enableDesc")}>
        <Switch checked={l10nEnabled()} onChange={setL10nEnabled} aria-label={t("l10n.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
