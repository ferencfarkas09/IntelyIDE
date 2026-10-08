import { t } from "../../i18n";
import { Button, ChartColumn, FormGroup, FormRow } from "../../ui-kit";
import { closeSettings } from "../../platform/settings";
import { openUsage } from "./open";

/** Settings section: where the Usage view is, one click away. */
export default function UsageSection() {
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
    </FormGroup>
  );
}
