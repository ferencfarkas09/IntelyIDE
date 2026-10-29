import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { sendToAgentEnabled, setSendToAgentEnabled, syncSendToAgentEnabled } from "./toggle";

/** Settings section: the toggle of the "Fix with agent" buttons. */
export default function SendSection() {
  onMount(() => void syncSendToAgentEnabled());
  return (
    <FormGroup title={t("toAgent.section.title")} description={t("toAgent.section.desc")}>
      <FormRow label={t("toAgent.section.enable")} description={t("toAgent.section.enableDesc")}>
        <Switch checked={sendToAgentEnabled()} onChange={setSendToAgentEnabled} aria-label={t("toAgent.section.enable")} />
      </FormRow>
    </FormGroup>
  );
}
