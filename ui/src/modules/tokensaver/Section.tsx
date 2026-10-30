import { onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Select, Switch } from "../../ui-kit";
import { TOKEN_HABITS_TEXT } from "./habits";
import { autoNudge, setAutoNudge, setThreshold, setTokenHabits, syncPrefs, threshold, THRESHOLDS, tokenHabits } from "./prefs";
import { setTokenSaverEnabled, syncTokenSaverEnabled, tokenSaverEnabled } from "./toggle";
import "./tokensaver.css";

/** Settings section: the extra's switch, the automatic nudge, the context threshold and the token-saving habits with their exact text. */
export default function Section() {
  onMount(() => void Promise.all([syncTokenSaverEnabled(), syncPrefs()]));
  return (
    <FormGroup title={t("tokensaver.section.title")} description={t("tokensaver.section.desc")}>
      <FormRow label={t("tokensaver.section.enable")} description={t("tokensaver.section.enableDesc")}>
        <Switch checked={tokenSaverEnabled()} onChange={setTokenSaverEnabled} aria-label={t("tokensaver.section.enable")} />
      </FormRow>
      <Show when={tokenSaverEnabled()}>
        <FormRow label={t("tokensaver.section.auto")} description={t("tokensaver.section.autoDesc")}>
          <Switch checked={autoNudge()} onChange={setAutoNudge} aria-label={t("tokensaver.section.auto")} />
        </FormRow>
        <FormRow label={t("tokensaver.section.threshold")} description={t("tokensaver.section.thresholdDesc")}>
          <Select size="sm" aria-label={t("tokensaver.section.threshold")} value={String(threshold())} options={THRESHOLDS.map((n) => ({ value: String(n), label: `${n}%` }))} onChange={(v) => setThreshold(Number(v))} />
        </FormRow>
      </Show>
      <FormRow label={t("tokensaver.section.habits")} description={t("tokensaver.section.habitsDesc")}>
        <Switch checked={tokenHabits()} onChange={setTokenHabits} aria-label={t("tokensaver.section.habits")} />
      </FormRow>
      <details class="ts-preview">
        <summary>{t("tokensaver.section.preview")}</summary>
        <pre class="ts-preview__text" tabIndex={0} data-testid="tokensaver-habits">{TOKEN_HABITS_TEXT}</pre>
      </details>
    </FormGroup>
  );
}
