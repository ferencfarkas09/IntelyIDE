import { createSignal, For, Show } from "solid-js";
import { t, type MessageKey } from "../../../i18n";
import type { Diagnosis } from "../../../ipc/mongo";
import { Button, CircleAlert, Copy, TriangleAlert } from "../../../ui-kit";
import "./stepper.css";
import { DIAG_FIXES, diagCodeOf, diagKey, diagParams } from "./logic";

export interface DiagnosisViewProps {
  diagnosis: Diagnosis;
  /** Name of the step that failed (already translated), shown in the header. */
  failedStep?: string;
  /** `authz.listDatabases` is a warning about the role, not a failed connection. */
  severity?: "error" | "warning";
  onRetry?: () => void;
  /** tunnel.hostKey*: open the host-key dialog. */
  onReviewHostKey?: () => void;
  /** tunnel.notAllowed: open the "Allow this host" dialog for `host:port`. */
  onAllowHost?: (host: string) => void;
  /** config.needsSecret: open the password prompt. */
  onEnterSecret?: () => void;
}

/** A failure as a title, a likely cause, a short list of fixes and the scrubbed technical text. All prose comes from `mongoDiag`; Rust only sends codes. */
export function DiagnosisView(props: DiagnosisViewProps) {
  const code = () => diagCodeOf(props.diagnosis.code);
  const params = () => diagParams(props.diagnosis);
  const host = () => params().host ?? t("mongoDiag.view.unknownHost");
  const fixes = () => Array.from({ length: DIAG_FIXES[code()] }, (_, i) => diagKey(code(), `fix${i + 1}`));
  const [copied, setCopied] = createSignal(false);
  const isHostKey = () => code().startsWith("tunnel.hostKey");
  const warn = () => (props.severity ?? (code() === "authz.listDatabases" ? "warning" : "error")) === "warning";
  const copy = () => {
    void navigator.clipboard?.writeText(props.diagnosis.detail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <article class="mgd" data-severity={warn() ? "warning" : "error"} data-code={code()}>
      <header class="mgd__head" role={warn() ? "status" : "alert"}>
        {warn() ? <TriangleAlert size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <div>
          <h3 class="mgd__title">{t(diagKey(code(), "title"))}</h3>
          <Show when={props.failedStep}>
            <p class="mgd__step">{t("mongoDiag.view.failedAt", { step: props.failedStep! })}</p>
          </Show>
        </div>
      </header>
      <section class="mgd__sec">
        <h4 class="mgd__h">{t("mongoDiag.view.cause")}</h4>
        <p class="mgd__p">{t(diagKey(code(), "cause"), { host: host() })}</p>
        <p class="mgd__note">{t("mongoDiag.view.likely")}</p>
      </section>
      <section class="mgd__sec">
        <h4 class="mgd__h">{t("mongoDiag.view.fixes")}</h4>
        <ul class="mgd__fixes">
          <For each={fixes()}>{(k) => <li>{t(k, { host: host() })}</li>}</For>
        </ul>
      </section>
      <Show when={params().hints.length > 0}>
        <section class="mgd__sec">
          <h4 class="mgd__h">{t("mongoDiag.view.hints")}</h4>
          <ul class="mgd__fixes">
            <For each={params().hints}>{(h) => <li>{t(`mongoDiag.hint.${h}` as MessageKey)}</li>}</For>
          </ul>
        </section>
      </Show>
      <div class="mgd__actions">
        <Show when={isHostKey() && props.onReviewHostKey}>
          <Button size="sm" variant="primary" onClick={() => props.onReviewHostKey?.()}>{t("mongoDiag.view.reviewHostKey")}</Button>
        </Show>
        <Show when={code() === "tunnel.notAllowed" && props.onAllowHost && params().host}>
          <Button size="sm" variant="primary" onClick={() => props.onAllowHost?.(params().host!)}>
            <span dir="ltr">{t("mongoDiag.view.allowHost", { host: params().host! })}</span>
          </Button>
        </Show>
        <Show when={code() === "config.needsSecret" && props.onEnterSecret}>
          <Button size="sm" variant="primary" onClick={() => props.onEnterSecret?.()}>{t("mongoDiag.view.enterSecret")}</Button>
        </Show>
        <Show when={props.diagnosis.retryable && props.onRetry}>
          <Button size="sm" variant="secondary" onClick={() => props.onRetry?.()}>{t("mongoDiag.view.retry")}</Button>
        </Show>
      </div>
      <Show when={props.diagnosis.detail}>
        <details class="mgd__details">
          <summary>{t("mongoDiag.view.details")}</summary>
          <pre class="mgd__raw" dir="ltr">{props.diagnosis.detail}</pre>
          <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>{copied() ? t("mongoDiag.view.copied") : t("mongoDiag.view.copy")}</Button>
        </details>
      </Show>
    </article>
  );
}
