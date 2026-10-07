import { For, Show } from "solid-js";
import { t } from "../../i18n";
import { repoName } from "../../store/actions";
import { Button, Dialog, Icon, ShieldAlert } from "../../ui-kit";
import { totalFindings } from "./logic";
import { answerSecretAsk, secretAsk } from "./secretGuard";
import "./checks.css";

/** Overlay: "This commit adds something that looks like a secret." Cancel is the default; the matched text is never shown. */
export default function SecretDialog() {
  const groups = () => secretAsk()?.groups ?? [];
  const n = () => totalFindings(groups());
  return (
    <Dialog
      open={secretAsk() !== null}
      onClose={() => answerSecretAsk(false)}
      role="alertdialog"
      size="md"
      title={t("checks.secret.title", { n: n() })}
      description={t("checks.secret.desc")}
      footer={
        <>
          <Button variant="ghost" onClick={() => answerSecretAsk(false)} data-autofocus>
            {t("checks.secret.cancel")}
          </Button>
          <Button variant="danger" icon={ShieldAlert} onClick={() => answerSecretAsk(true)}>
            {t("checks.secret.confirm")}
          </Button>
        </>
      }
    >
      <div class="sec" aria-label={t("checks.secret.aria")}>
        <For each={groups()}>
          {(g) => (
            <section class="sec__group">
              <h4 class="sec__repo">{repoName(g.repoId)}</h4>
              <ul class="sec__list">
                <For each={g.findings}>
                  {(f) => (
                    <li class="sec__item">
                      <div class="sec__top">
                        <span class="ui-mono ui-truncate sec__path" title={f.path}>{f.path}</span>
                        <Show when={f.line}><span class="sec__line ui-tnum">{t("checks.secret.line", { n: f.line })}</span></Show>
                        <span class="sec__kind"><Icon icon={ShieldAlert} size={12} /> {f.kind}</span>
                      </div>
                      <code class="sec__preview">{f.preview}</code>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  );
}
