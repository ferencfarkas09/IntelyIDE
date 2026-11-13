import { onMount } from "solid-js";
import { t } from "../../i18n";
import { Button, ChartColumn, FormGroup, FormRow, Switch } from "../../ui-kit";
import { closeSettings } from "../../platform/settings";
import { planBar } from "./bar";
import { openUsage } from "./open";

/** Settings section: where the Usage view is, one click away, and the switch of the plan usage items of the bottom bar. */
export default function UsageSection() {
  onMount(() => void planBar.sync());
  return (
    <FormGroup title={t("usage.section.title")} description={t("usage.section.desc")}>
      <FormRow label={t("usage.section.open")} description={t("usage.section.openDesc")}>
        <Button
          size="sm"
          variant="secondary"
          icon={ChartColumn}
          onClick={() => {
            closeSettings();
            openUsage();
          }}
        >
          {t("usage.section.button")}
        </Button>
      </FormRow>
      <FormRow label={t("usage.section.bar")} description={t("usage.section.barDesc")}>
        <Switch checked={planBar.on()} onChange={planBar.set} aria-label={t("usage.section.bar")} />
      </FormRow>
    </FormGroup>
  );
}
