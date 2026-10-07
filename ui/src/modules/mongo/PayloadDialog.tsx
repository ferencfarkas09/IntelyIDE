import { createResource, For, Show } from "solid-js";
import type { AiPayload } from "../../ipc/mongoAi";
import { t } from "../../i18n";
import { Badge, Button, Copy, Dialog, Skeleton, toast } from "../../ui-kit";
import { describeError } from "./model";

export interface PayloadDialogProps {
  load: () => Promise<AiPayload>;
  onClose: () => void;
  /** Present before the first send: the user agrees to exactly this and the question goes out. */
  onAgree?: () => void;
}

/** "What is sent?": the exact post-filter bytes the model would receive, and a plain list of what that means. */
export function PayloadDialog(props: PayloadDialogProps) {
  const [payload] = createResource(() => props.load().catch((e) => ({ failed: describeError(e).detail })));
  const ok = () => {
    const p = payload();
    return p && !("failed" in p) ? p : undefined;
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={props.onClose}
      title={props.onAgree ? t("mongoStudio.payload.titleAgree") : t("mongoStudio.payload.title")}
      description={t("mongoStudio.payload.desc")}
      footer={
        <>
          <Button variant="ghost" icon={Copy} disabled={!ok()} onClick={() => void navigator.clipboard?.writeText(ok()!.text).then(() => toast.info(t("mongoStudio.payload.copied")))}>{t("mongoStudio.payload.copy")}</Button>
          <Button variant="secondary" onClick={props.onClose}>{props.onAgree ? t("mongoStudio.payload.cancel") : t("mongoStudio.payload.close")}</Button>
          <Show when={props.onAgree}>
            {/* While the payload is built the button shows its busy state instead of the flat disabled grey: a grey primary read as "not clickable" for a moment on every open. */}
            <Button variant="primary" data-autofocus loading={payload.loading} disabled={!payload.loading && !ok()} onClick={props.onAgree}>{t("mongoStudio.payload.send")}</Button>
          </Show>
        </>
      }
    >
      <Show when={ok()} fallback={<Show when={payload.loading} fallback={<p class="mg-form__bad" role="alert">{(payload() as { failed: string } | undefined)?.failed ?? t("mongoStudio.payload.failed")}</p>}><div class="mg-payload"><Skeleton height={14} /><Skeleton height={14} width="80%" /><Skeleton height={140} /></div></Show>}>
        {(p) => (
          <div class="mg-payload">
            <ul class="mg-payload__list">
              <li>{t("mongoStudio.payload.question", { n: p().maskedLiterals ?? 0 })}</li>
              <li>{t("mongoStudio.payload.names")}</li>
              <li>{t("mongoStudio.payload.fields", { n: p().keptNames.length })}{p().replacedNames ? t("mongoStudio.payload.fieldsHidden", { n: p().replacedNames }) : ""}</li>
              <li>{t("mongoStudio.payload.indexes")}</li>
            </ul>
            <div class="mg-payload__stats">
              <Badge numeric>{t("mongoStudio.payload.bytes", { n: p().bytes })}</Badge>
              <Badge numeric>{t("mongoStudio.payload.tokens", { n: p().tokensEstimate })}</Badge>
              <Badge tone="accent">{t("mongoStudio.payload.p1")}</Badge>
              <For each={p().notes}>{(n) => <Badge tone="warn">{n}</Badge>}</For>
            </div>
            <pre class="mg-payload__text ui-mono ui-selectable" tabIndex={0} aria-label={t("mongoStudio.payload.exact")}>{p().text}</pre>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
