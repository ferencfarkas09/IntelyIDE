import { t } from "../../i18n";
import { openSettings } from "../../platform/settings";
import { signedOutNotice } from "../../store/happy";
import { Icon, TriangleAlert } from "../../ui-kit";

/** Persistent: stays until a new token is saved (plan 1.4). */
export default function SignedOutNotice() {
  return (
    <button type="button" class="sb__item sb__attention happy-signedout" title={signedOutNotice()?.message} onClick={() => openSettings("integrations")}>
      <Icon icon={TriangleAlert} size={12} />
      <span>{t("integrations.signedOut")}</span>
    </button>
  );
}
