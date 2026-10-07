import { Show } from "solid-js";
import { FormGroup, FormRow, Info, Switch } from "../../ui-kit";
import { isMachineTranslated, setLocale, t, type Locale } from "../../i18n";
import { applyGeneral } from "./general";
import { LanguagePicker } from "./LanguagePicker";
import { normalizeGeneral, NS } from "./model";
import { useNamespace } from "./namespace";
import { RepoList } from "./RepoList";
import "./settings-core.css";

export default function GeneralSection() {
  const general = useNamespace(NS.general, normalizeGeneral, applyGeneral);
  // Switch the UI first (a lazy catalog may take a moment), then store the choice in settings.json.
  const pick = (language: Locale) => void setLocale(language).then(() => general.update({ language }));
  return (
    <div class="sc-section">
      <FormGroup>
        <FormRow label={t("general.language")} description={t("general.languageDesc")} stacked>
          <LanguagePicker onPick={pick} />
        </FormRow>
        <Show when={isMachineTranslated()}>
          <p class="sc-note" role="note">
            <Info size={14} aria-hidden="true" />
            {t("general.machineNotice")}
          </p>
        </Show>
        <FormRow label={t("general.refresh")} description={t("general.refreshDesc")}>
          <Switch aria-label={t("general.refresh")} checked={general.value().fetchOnFocus} onChange={(fetchOnFocus) => void general.update({ fetchOnFocus })} />
        </FormRow>
      </FormGroup>
      <FormGroup>
        <FormRow label={t("general.repos")} description={t("general.reposDesc")} stacked>
          <RepoList />
        </FormRow>
      </FormGroup>
    </div>
  );
}
