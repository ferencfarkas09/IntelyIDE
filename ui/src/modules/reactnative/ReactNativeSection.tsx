import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { reactNativeEnabled, setReactNativeEnabled, syncReactNativeEnabled } from "./toggle";

/** Settings section: the toggle that shows the React Native panel (in workspaces that have such a project). */
export default function ReactNativeSection() {
  onMount(() => void syncReactNativeEnabled());
  return (
    <FormGroup title={t("reactnative.section.title")} description={t("reactnative.section.desc")}>
      <FormRow label={t("reactnative.section.enable")} description={t("reactnative.section.enableDesc")}>
        <Switch checked={reactNativeEnabled()} onChange={setReactNativeEnabled} aria-label={t("reactnative.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
