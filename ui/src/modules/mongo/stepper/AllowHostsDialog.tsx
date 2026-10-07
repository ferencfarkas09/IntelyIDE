import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../../i18n";
import { Button, Dialog, TriangleAlert } from "../../../ui-kit";
import "./stepper.css";
import { allowProblem } from "./logic";

export interface AllowHostsDialogProps {
  open: boolean;
  /** `host:port` entries. One entry reads "Allow this host?", several "Allow these N hosts?". */
  hosts: readonly string[];
  /** Saving widens the signed allow-list; the caller does it and may reject. */
  onConfirm: (hosts: string[]) => void | Promise<void>;
  onClose: () => void;
}

/** Names every destination before the tunnel may open connections to it. Link-local and metadata addresses can never be confirmed. */
export function AllowHostsDialog(props: AllowHostsDialogProps) {
  const entries = createMemo(() => props.hosts.map((h) => ({ host: h, problem: allowProblem(h) })));
  const blocked = () => entries().some((e) => e.problem);
  const [busy, setBusy] = createSignal(false);
  const count = () => props.hosts.length;
  async function confirm() {
    setBusy(true);
    try {
      await props.onConfirm([...props.hosts]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("mongoDiag.allow.title", { count: count() })}
      description={t("mongoDiag.allow.body", { count: count() })}
      size="sm"
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" data-autofocus onClick={props.onClose}>{t("mongoDiag.allow.cancel")}</Button>
          <Button variant="primary" loading={busy()} disabled={blocked() || count() === 0} onClick={() => void confirm()}>{t("mongoDiag.allow.confirm")}</Button>
        </>
      }
    >
      <ul class="mga" role="list" aria-label={t("mongoDiag.allow.list")}>
        <For each={entries()}>
          {(e) => (
            <li class="mga__row" data-bad={e.problem ? "" : undefined}>
              <code dir="ltr" class="mga__host">{e.host}</code>
              <Show when={e.problem}>
                <span class="mga__problem"><TriangleAlert size={12} aria-hidden="true" />{e.problem === "linkLocal" ? t("mongoDiag.allow.invalid.linkLocal") : t("mongoDiag.allow.invalid.format")}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Dialog>
  );
}
