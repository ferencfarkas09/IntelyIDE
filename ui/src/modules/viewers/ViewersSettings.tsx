import { createResource } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { setViewersEnabled, viewersEnabled } from "./state";
import "./viewers.css";

/** Settings > Viewers: one switch. Off removes the commands and the dock tab's entry points; nothing else of the module runs anyway. */
export default function ViewersSettings() {
  const [ns] = createResource(() => ipc.settings.get("viewers"));
  const on = () => (typeof ns()?.enabled === "boolean" ? (ns()!.enabled as boolean) : viewersEnabled());
  const set = (enabled: boolean) => {
    setViewersEnabled(enabled);
    void ipc.settings.set("viewers", { enabled });
  };
  return (
    <div>
      <FormGroup>
        <FormRow label={t("viewers.enable")} description={t("viewers.enableDesc")}>
          <Switch checked={on()} onChange={set} aria-label={t("viewers.enableAria")} />
        </FormRow>
      </FormGroup>
      <p>
        {t("viewers.safetyNote")}
      </p>
    </div>
  );
}
