import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { contractEnabled, setContractEnabled, syncContractEnabled } from "./toggle";

/** Settings section: the toggle that loads the contract module (nothing of it runs while it is off). */
export default function ContractSection() {
  onMount(() => void syncContractEnabled());
  return (
    <FormGroup title={t("contract.section.title")} description={t("contract.section.desc")}>
      <FormRow label={t("contract.section.enable")} description={t("contract.section.enableDesc")}>
        <Switch checked={contractEnabled()} onChange={setContractEnabled} aria-label={t("contract.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
