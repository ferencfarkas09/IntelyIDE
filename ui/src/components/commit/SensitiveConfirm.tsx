import { For, Show } from "solid-js";
import { answerSensitiveConfirm, repoName, sensitiveConfirmRequest } from "../../store/actions";
import { Button, Dialog, Icon, Lock } from "../../ui-kit";
import { splitPath } from "../push/logic";
import { t } from "../../i18n";
import "./commit.css";

/** One more question before tracked files that look like credentials (`.npmrc`) go into a commit. */
export function SensitiveConfirm() {
  const files = () => sensitiveConfirmRequest()?.files ?? [];
  const many = () => files().length > 1;
  return (
    <Dialog
      open={sensitiveConfirmRequest() !== null}
      onClose={() => answerSensitiveConfirm(false)}
      role="alertdialog"
      size="sm"
      title={many() ? t("commit.sens.titleMany") : t("commit.sens.titleOne")}
      description={t("commit.sens.desc")}
      footer={
        <>
          <Button variant="ghost" onClick={() => answerSensitiveConfirm(false)} data-autofocus>
            {t("comp.cancel")}
          </Button>
          <Button variant="danger" icon={Lock} onClick={() => answerSensitiveConfirm(true)}>
            {t("commit.sens.anyway")}
          </Button>
        </>
      }
    >
      <ul class="sensitive-list" aria-label={t("commit.sens.aria")}>
        <For each={files()}>
          {(f) => (
            <li class="sensitive-list__row">
              <Icon icon={Lock} size={12} />
              <span class="ui-mono ui-truncate" title={f.path}>
                {splitPath(f.path).name}
              </span>
              <Show when={splitPath(f.path).dir}>
                <span class="ui-path-hint">{splitPath(f.path).dir}</span>
              </Show>
              <span class="sensitive-list__repo">{repoName(f.repoId)}</span>
            </li>
          )}
        </For>
      </ul>
    </Dialog>
  );
}
