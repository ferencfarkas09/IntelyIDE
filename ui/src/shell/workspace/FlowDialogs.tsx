import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { Picked } from "../../ipc/picker";
import { Badge, Button, Checkbox, Dialog, Icon, Input, ShieldAlert } from "../../ui-kit";
import { shortPath } from "./format";
import { kindLine, riskKeys, warningLines } from "./pickedText";

/*
 * Small answer dialogs the workspace flows need outside the picker: a typed confirmation (relocating a repository to a
 * different one) and the review card of a dropped folder (kind, warnings, trust). Flows call `typedConfirm` / `reviewPicked`
 * and await the answer; the host component renders the dialog. It is mounted once as a platform overlay.
 */

interface TypedRequest {
  title: string;
  body: string;
  /** The text the user has to type (compared after NFC). */
  expected: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

const [typedRequest, setTypedRequest] = createSignal<TypedRequest | null>(null);

export function typedConfirm(req: Omit<TypedRequest, "resolve">): Promise<boolean> {
  typedRequest()?.resolve(false);
  return new Promise<boolean>((resolve) => setTypedRequest({ ...req, resolve }));
}

export interface ReviewRequest {
  items: Picked[];
  confirmLabel: string;
  resolve: (trusted: Set<string> | null) => void;
}

const [reviewRequest, setReviewRequest] = createSignal<ReviewRequest | null>(null);

/**
 * Shows what is about to be added: the kind, warnings and, for a repository whose Git settings can run programs, the trust
 * checkbox. Resolves with the tokens the user trusted, or `null` on cancel.
 */
export function reviewPicked(items: Picked[], confirmLabel: string): Promise<Set<string> | null> {
  reviewRequest()?.resolve(null);
  return new Promise((resolve) => setReviewRequest({ items, confirmLabel, resolve }));
}

function TypedConfirmDialog() {
  const [text, setText] = createSignal("");
  createEffect(on(typedRequest, () => setText("")));
  const ok = () => {
    const r = typedRequest();
    return !!r && text().normalize("NFC").trim() === r.expected.normalize("NFC");
  };
  const done = (answer: boolean) => {
    const r = typedRequest();
    setTypedRequest(null);
    r?.resolve(answer);
  };
  return (
    <Dialog
      open={typedRequest() !== null}
      onClose={() => done(false)}
      title={typedRequest()?.title ?? ""}
      description={typedRequest()?.body}
      size="sm"
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>{t("manage.cancel")}</Button>
          <Button variant="danger" disabled={!ok()} onClick={() => ok() && done(true)}>{typedRequest()?.confirmLabel}</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok()) done(true);
        }}
      >
        <label class="flow__field">
          {t("picker.init.confirm", { name: typedRequest()?.expected ?? "" })}
          <Input data-autofocus value={text()} onInput={(e) => setText(e.currentTarget.value)} autocomplete="off" spellcheck={false} />
        </label>
      </form>
    </Dialog>
  );
}

function ReviewDialog() {
  const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(on(reviewRequest, () => setTicked(new Set<string>())));
  const risky = () => (reviewRequest()?.items ?? []).filter((p) => p.configRisks.length > 0);
  const ready = () => risky().every((p) => ticked().has(p.token));
  const done = (answer: boolean) => {
    const r = reviewRequest();
    setReviewRequest(null);
    r?.resolve(answer ? new Set(risky().map((p) => p.token)) : null);
  };
  return (
    <Dialog
      open={reviewRequest() !== null}
      onClose={() => done(false)}
      title={(reviewRequest()?.items.length ?? 0) > 1 ? t("welcome.review.titleMany") : t("welcome.review.title")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>{t("manage.cancel")}</Button>
          <Button variant="primary" data-autofocus disabled={!ready()} title={ready() ? undefined : t("picker.trust.disabledReason")} onClick={() => ready() && done(true)}>
            {reviewRequest()?.confirmLabel}
          </Button>
        </>
      }
    >
      <ul class="flow__review" role="list">
        <For each={reviewRequest()?.items ?? []}>
          {(p) => (
            <li class="flow__review-item">
              <div class="flow__review-head">
                <strong dir="ltr">{p.name}</strong>
                <Badge tone="neutral" size="sm">{kindLine(p)}</Badge>
              </div>
              <p class="flow__review-path" dir="ltr">{shortPath(p.path)}</p>
              <For each={warningLines(p)}>{(line) => <p class="flow__warn">{line}</p>}</For>
              <Show when={p.configRisks.length > 0}>
                <div class="flow__risk" role="group" aria-label={t("picker.risk.title")}>
                  <p class="flow__risk-title"><Icon icon={ShieldAlert} size={14} /> {t("picker.risk.title")}</p>
                  <p>{t("picker.risk.body", { keys: riskKeys(p) })}</p>
                  <Checkbox
                    label={t("picker.risk.confirm")}
                    checked={ticked().has(p.token)}
                    onChange={(v) => setTicked((s) => new Set(v ? [...s, p.token] : [...s].filter((x) => x !== p.token)))}
                  />
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Dialog>
  );
}

/** Both dialogs; mounted once as a platform overlay (`registerWorkspaceOverlays`). */
export default function FlowDialogs() {
  return (
    <>
      <TypedConfirmDialog />
      <ReviewDialog />
    </>
  );
}
