import { Show } from "solid-js";
import { t } from "../../i18n";
import { checksEnabled, secretGuardEnabled, setChecksEnabled, setSecretGuardEnabled } from "../checks/toggle";
import { Button, Icon, ShieldAlert } from "../../ui-kit";

/** True when the secret-in-diff check runs before a commit: the Checks extra and its secret switch are both on. */
export const secretGuardOn = (): boolean => checksEnabled() && secretGuardEnabled();

/** "The check for secrets before a commit is off. Turn it on": shown only while it is off. */
export function SecretGuardOffer() {
  const turnOn = () => {
    setChecksEnabled(true);
    setSecretGuardEnabled(true);
  };
  return (
    <Show when={!secretGuardOn()}>
      <p class="presets__offer" role="status">
        <Icon icon={ShieldAlert} size={14} />
        <span>{t("presets.secretOff")}</span>
        <Button size="sm" variant="secondary" onClick={turnOn}>{t("presets.secretOn")}</Button>
      </p>
    </Show>
  );
}
