import { createEffect, createSignal, createUniqueId, For, on, type JSX, Show, splitProps } from "solid-js";
import { fmt, t, type MessageKey } from "../../../i18n";
import { Badge, Button, Checkbox, CircleAlert, Copy, Dialog, Info, Input, TriangleAlert, toast } from "../../../ui-kit";
import type { ButtonProps } from "../../../ui-kit";
import { errorCodeOf, errorDetailOf, errorText, FREE_DAILY_FRAMES, groupHex } from "./logic";
import type { LimitsNotice } from "./types";

export const messageOf = (e: unknown): string => errorText(errorCodeOf(e));

/** A button that stays focusable when blocked (`aria-disabled`) and points at the reason, so a screen reader hears why. */
export function ReasonButton(props: ButtonProps & { reason: string | null; reasonId: string }) {
  const [local, rest] = splitProps(props, ["reason", "reasonId", "onClick", "class", "children"]);
  return (
    <Button
      {...rest}
      class={`cloud-reason-btn${local.class ? ` ${local.class}` : ""}`}
      aria-disabled={local.reason ? "true" : undefined}
      aria-describedby={local.reason ? local.reasonId : undefined}
      onClick={(e) => {
        if (local.reason) return e.preventDefault();
        if (typeof local.onClick === "function") (local.onClick as (ev: MouseEvent) => void)(e as MouseEvent);
      }}
    >
      {local.children}
    </Button>
  );
}

export function copyText(text: string, doneKey: "remote.cloud.copied" | "remote.cloud.logCopied" = "remote.cloud.copied"): void {
  void navigator.clipboard?.writeText(text).then(() => toast.show({ title: t(doneKey), tone: "ok", duration: 2500 }), () => {});
}

/** The error summary: `role="alert"`, focused after a failure so the cause is read first. */
export function ErrorSummary(props: { code: string | null; detail?: string | null; tail?: string[] }) {
  let el: HTMLParagraphElement | undefined;
  createEffect(on(() => props.code, (c) => c && queueMicrotask(() => el?.focus())));
  return (
    <Show when={props.code}>
      <div class="cloud-error">
        <p ref={el} role="alert" tabIndex={-1} class="cloud-error__text" data-testid="cloud-error">
          <CircleAlert size={14} /> <span>{errorText(props.code!)}</span>
          <Show when={props.detail}> <span class="cloud-note">({props.detail})</span></Show>
        </p>
        <Show when={props.tail?.length}>
          <pre class="cloud-tail" dir="ltr">{props.tail!.join("\n")}</pre>
        </Show>
      </div>
    </Show>
  );
}
export { errorCodeOf, errorDetailOf };

/** Masked output exactly as received (the UI never unmasks). 3000 lines or 512 KB are kept. */
export function LogPane(props: { lines: string[]; label: string }) {
  let el: HTMLDivElement | undefined;
  let pinned = true;
  createEffect(
    on(
      () => props.lines.length,
      () => queueMicrotask(() => pinned && el && (el.scrollTop = el.scrollHeight)),
    ),
  );
  return (
    <div class="cloud-logwrap">
      <div
        ref={el}
        class="cloud-log"
        role="log"
        aria-live="off"
        aria-label={props.label}
        tabIndex={0}
        dir="ltr"
        data-testid="cloud-log"
        onScroll={() => el && (pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24)}
      >
        <For each={props.lines} fallback={<span class="cloud-note">{t("remote.cloud.log.empty")}</span>}>{(l) => <div class="cloud-log__line">{l}</div>}</For>
      </div>
      <Button size="sm" variant="ghost" icon={Copy} onClick={() => copyText(props.lines.join("\n"), "remote.cloud.logCopied")} disabled={!props.lines.length}>
        {t("remote.cloud.log.copy")}
      </Button>
    </div>
  );
}

/** Dialog that asks for an exact typed phrase (and optionally a checkbox) before an irreversible step. */
export function TypedConfirm(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: JSX.Element;
  /** What must be typed, exactly (case-sensitive). */
  expected: string;
  confirmLabel: string;
  danger?: boolean;
  checkbox?: string;
  /** Gets the text that was typed (equal to `expected` whenever the button is enabled). */
  onConfirm: (typed: string) => Promise<void>;
  children?: JSX.Element;
}) {
  const [typed, setTyped] = createSignal("");
  const [ack, setAck] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [code, setCode] = createSignal<string | null>(null);
  const reasonId = createUniqueId();
  const inputId = createUniqueId();
  createEffect(on(() => props.open, (o) => o && (setTyped(""), setAck(false), setCode(null))));
  const reason = () => (props.checkbox && !ack() ? t("remote.cloud.block.ack") : typed() !== props.expected ? t("remote.cloud.block.typed", { text: props.expected }) : null);
  const go = async () => {
    setBusy(true);
    setCode(null);
    try {
      await props.onConfirm(typed());
      props.onClose();
    } catch (e) {
      setCode(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      size="sm"
      role="alertdialog"
      description={props.description}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t("remote.cloud.cancel")}
          </Button>
          <ReasonButton variant={props.danger ? "danger" : "primary"} reason={reason()} reasonId={reasonId} loading={busy()} onClick={() => void go()} data-testid="typed-confirm">
            {props.confirmLabel}
          </ReasonButton>
        </>
      }
    >
      <div class="cloud-stack">
        {props.children}
        <Show when={props.checkbox}>
          <Checkbox checked={ack()} onChange={setAck} label={props.checkbox} />
        </Show>
        <label class="cloud-label" for={inputId}>
          {t("remote.cloud.typeToConfirm", { text: props.expected })}
        </label>
        <Input id={inputId} size="sm" value={typed()} spellcheck={false} autocomplete="off" autocapitalize="off" data-autofocus onInput={(e) => setTyped(e.currentTarget.value)} data-testid="typed-input" />
        <p id={reasonId} class="cloud-note" aria-live="polite">
          {reason() ?? t("remote.cloud.block.ready")}
        </p>
        <ErrorSummary code={code()} />
      </div>
    </Dialog>
  );
}

/** Section 2 of the spec, shown before the first deploy and next to "Use this relay" for a custom URL. */
export function TrustNote(props: { compact?: boolean }) {
  return (
    <div class="cloud-trust" data-testid="trust-note">
      <p class="cloud-trust__title">
        <Info size={14} /> {t("remote.cloud.trust.title")}
      </p>
      <ul>
        <li>{t("remote.cloud.trust.e2e")}</li>
        <li>{t("remote.cloud.trust.meta")}</li>
        <li>
          <strong>{t("remote.cloud.trust.code")}</strong>
        </li>
        <Show when={!props.compact}>
          <li>{t("remote.cloud.trust.signed")}</li>
          <li>{t("remote.cloud.trust.operator")}</li>
        </Show>
      </ul>
    </div>
  );
}

const nums = (a: number[]): Record<string, number> => Object.fromEntries(a.map((n, i) => [`n${i}`, n]));

const LIMIT_LABEL = {
  workerRequests: "remote.cloud.limits.workerRequests",
  doRequests: "remote.cloud.limits.doRequests",
  doDuration: "remote.cloud.limits.doDuration",
  sqlRows: "remote.cloud.limits.sqlRows",
  sqlStorage: "remote.cloud.limits.sqlStorage",
  assets: "remote.cloud.limits.assets",
  websocket: "remote.cloud.limits.websocket",
} as const;

/** Costs and limits with the doc date; the numbers are data from Rust (`limits.rs`), the words are ours. */
export function CostsNotice(props: { notice: LimitsNotice; open?: boolean }) {
  const stale = () => props.notice.staleDays > 180;
  return (
    <details class="cloud-costs" open={props.open} data-testid="costs">
      <summary>{t("remote.cloud.costs.title")}</summary>
      <p class="cloud-note" classList={{ "cloud-warn": stale() }} role={stale() ? "alert" : undefined}>
        {stale() ? <TriangleAlert size={12} /> : null} {t("remote.cloud.costs.header", { date: fmt.date(new Date(props.notice.checkedOn)) })}
        {stale() ? ` ${t("remote.cloud.costs.stale")}` : ""}
      </p>
      <table class="cloud-table">
        <thead>
          <tr>
            <th scope="col">{t("remote.cloud.costs.item")}</th>
            <th scope="col">{t("remote.cloud.costs.free")}</th>
            <th scope="col">{t("remote.cloud.costs.paid")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.notice.rows}>
            {(r) => (
              <tr>
                <th scope="row">{t(LIMIT_LABEL[r.key])}</th>
                <td>{t(`remote.cloud.limits.${r.key}.free` as MessageKey, nums(r.free))}</td>
                <td>{t(`remote.cloud.limits.${r.key}.paid` as MessageKey, nums(r.paid))}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <ul class="cloud-notes">
        <li>{t("remote.cloud.costs.freeCap", { n: fmt.number(FREE_DAILY_FRAMES) })}</li>
        <li>{t("remote.cloud.costs.unverified")}</li>
        <li>{t("remote.cloud.costs.public")}</li>
        <li>
          <strong>{t("remote.cloud.costs.billing")}</strong>
        </li>
        <li>{t("remote.cloud.costs.estimate")}</li>
      </ul>
    </details>
  );
}

export function Fingerprint(props: { value: string }) {
  return (
    <span class="cloud-mono" dir="ltr">
      {groupHex(props.value.replace(/\s+/g, ""))}
    </span>
  );
}

export function StatusBadge(props: { tone: "ok" | "warn" | "danger" | "neutral"; children: JSX.Element }) {
  return (
    <Badge tone={props.tone} icon={props.tone === "ok" ? undefined : props.tone === "neutral" ? undefined : props.tone === "warn" ? TriangleAlert : CircleAlert}>
      {props.children}
    </Badge>
  );
}
