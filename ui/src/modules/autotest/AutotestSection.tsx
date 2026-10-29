import { createSignal, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, FormGroup, FormRow, SegmentedControl, Switch } from "../../ui-kit";
import { forgetAnswers, loadPrefs, prefs, setMode } from "./store";
import { autotestEnabled, setAutotestEnabled, syncAutotestEnabled } from "./toggle";
import type { AutotestMode } from "./types";

/** Settings section: the extra's switch, when to run the tests, and the remembered answers of the repositories. */
export default function AutotestSection() {
  const [forgotten, setForgotten] = createSignal(false);
  onMount(() => {
    void syncAutotestEnabled();
    void loadPrefs();
  });
  const remembered = () => Object.keys(prefs().repos).length;
  return (
    <FormGroup title={t("autotest.section.title")} description={t("autotest.section.desc")}>
      <FormRow label={t("autotest.section.enable")} description={t("autotest.section.enableDesc")}>
        <Switch checked={autotestEnabled()} onChange={setAutotestEnabled} aria-label={t("autotest.section.enableAria")} />
      </FormRow>
      <FormRow label={t("autotest.section.mode")} description={t(`autotest.section.modeDesc.${prefs().mode}`)}>
        <SegmentedControl<AutotestMode>
          aria-label={t("autotest.section.mode")}
          size="sm"
          value={prefs().mode}
          onChange={setMode}
          options={[
            { value: "off", label: t("autotest.mode.off") },
            { value: "ask", label: t("autotest.mode.ask") },
            { value: "always", label: t("autotest.mode.always") },
          ]}
        />
      </FormRow>
      <FormRow label={t("autotest.section.forget")} description={forgotten() ? t("autotest.section.forgotten") : t("autotest.section.forgetDesc", { n: remembered() })}>
        <Show when={remembered() > 0 || !forgotten()}>
          <Button
            size="sm"
            variant="secondary"
            disabled={remembered() === 0}
            onClick={() => {
              forgetAnswers();
              setForgotten(true);
            }}
          >
            {t("autotest.section.forgetButton")}
          </Button>
        </Show>
      </FormRow>
    </FormGroup>
  );
}
