import { t } from "../../i18n";
import { Button, ShieldAlert } from "../../ui-kit";

/** The macOS privacy explainer ((design notes: workspaces-spec) 3.6.3): why the prompt exists, how to fix a refusal. */
export function PermissionCard(props: { folder: string; onOpenSettings(): void; onRetry(): void; onOther(): void }) {
  return (
    <section class="pp-card pp-card--warn" role="alert" aria-labelledby="pp-perm-title">
      <h3 id="pp-perm-title" class="pp-card__title">
        <ShieldAlert size={16} aria-hidden="true" /> {t("picker.perm.title")}
      </h3>
      <p class="pp-card__text pp-card__folder" dir="auto">
        {props.folder}
      </p>
      <p class="pp-card__text">{t("picker.perm.body")}</p>
      <p class="pp-card__text">{t("picker.perm.fix")}</p>
      <div class="pp-card__actions">
        <Button size="sm" onClick={props.onOpenSettings}>
          {t("picker.perm.open")}
        </Button>
        <Button size="sm" onClick={props.onRetry}>
          {t("picker.perm.retry")}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onOther}>
          {t("picker.perm.other")}
        </Button>
      </div>
    </section>
  );
}
