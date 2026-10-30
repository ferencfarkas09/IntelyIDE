import { onMount } from "solid-js";
import { t } from "../../i18n";
import { resetWidgetLayout, syncWidgetLayout } from "../../platform/widgets";
import { Button, FormGroup, FormRow, RotateCcw, Switch, toast } from "../../ui-kit";
import { dashboardAtStart, dashboardEnabled, setDashboardAtStart, setDashboardEnabled, setTrayPlanEnabled, syncDashboardPrefs, trayPlanEnabled } from "./toggle";

/** Settings section: the dashboard extra, whether it opens at start, the plan usage in the menu bar and a layout reset. */
export default function DashboardSection() {
  onMount(() => {
    void syncDashboardPrefs();
    void syncWidgetLayout();
  });
  return (
    <FormGroup title={t("dash.section.title")} description={t("dash.section.desc")}>
      <FormRow label={t("dash.section.enable")} description={t("dash.section.enableDesc")}>
        <Switch checked={dashboardEnabled()} onChange={setDashboardEnabled} aria-label={t("dash.section.enable")} />
      </FormRow>
      <FormRow label={t("dash.section.atStart")} description={t("dash.section.atStartDesc")}>
        <Switch checked={dashboardAtStart()} disabled={!dashboardEnabled()} onChange={setDashboardAtStart} aria-label={t("dash.section.atStart")} />
      </FormRow>
      <FormRow label={t("dash.section.tray")} description={t("dash.section.trayDesc")}>
        <Switch checked={trayPlanEnabled()} disabled={!dashboardEnabled()} onChange={setTrayPlanEnabled} aria-label={t("dash.section.tray")} />
      </FormRow>
      <FormRow label={t("dash.section.layout")} description={t("dash.section.layoutDesc")}>
        <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => (resetWidgetLayout(), toast.success(t("dash.edit.resetDone")))}>
          {t("dash.edit.reset")}
        </Button>
      </FormRow>
    </FormGroup>
  );
}
