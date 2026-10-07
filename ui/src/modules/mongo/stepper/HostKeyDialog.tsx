import { createSignal, createUniqueId, For, Show } from "solid-js";
import { t } from "../../../i18n";
import type { HostKeyView } from "../../../ipc/mongo";
import { Button, Copy, Dialog, Input, ShieldAlert, TriangleAlert } from "../../../ui-kit";
import "./stepper.css";
import { fingerprintGroups, forgetConfirmed, hostKeyMode, manualSshCommand } from "./logic";

export interface HostKeyDialogProps {
  open: boolean;
  /** The scanned key. Absent only for an unscannable bastion. */
  view?: HostKeyView;
  /** The bastion cannot be scanned (ProxyJump, ProxyCommand, alias): show the manual fallback. */
  unscannable?: boolean;
  /** Host name for the unscannable case, where there is no `view`. */
  host?: string;
  /** The fingerprint saved earlier, for a changed key. */
  expectedFingerprint?: string;
  /** Unknown key only. Rejects when the fresh scan no longer matches. A changed key never reaches this. */
  onTrust: (view: HostKeyView) => void | Promise<void>;
  /** Changed key: remove the app-owned entry. `typedHost` is what the user typed; the caller sends it to Rust. */
  onForget: (typedHost: string) => void | Promise<void>;
  onClose: () => void;
}

function Fingerprint(props: { label: string; value: string; tone?: "bad" }) {
  const f = () => fingerprintGroups(props.value);
  return (
    <div class="mgk-fp" data-tone={props.tone}>
      <span class="mgk-fp__label">{props.label}</span>
      <code class="mgk-fp__value" dir="ltr" aria-label={props.value}>
        <span class="mgk-fp__prefix">{f().prefix}</span>
        <For each={f().groups}>{(g) => <span class="mgk-fp__g">{g}</span>}</For>
      </code>
    </div>
  );
}

/** The first-contact, changed-key and unscannable cases of an SSH host key. A changed key has no trust button and no override. */
export function HostKeyDialog(props: HostKeyDialogProps) {
  const mode = () => hostKeyMode(props.view, props.unscannable);
  const hostLabel = () => (props.view ? `${props.view.host}:${props.view.port}` : props.host ?? "");
  const [busy, setBusy] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [failed, setFailed] = createSignal<"trust" | "forget">();
  const [forgotten, setForgotten] = createSignal(false);
  const typedId = createUniqueId();
  const command = () => manualSshCommand(props.host ?? props.view?.host ?? "");

  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  async function run(kind: "trust" | "forget", fn: () => void | Promise<void>) {
    setBusy(true);
    setFailed(undefined);
    try {
      await fn();
      if (kind === "forget") {
        setForgotten(true);
        setTyped("");
      }
    } catch {
      setFailed(kind);
    } finally {
      setBusy(false);
    }
  }

  const title = () => (mode() === "changed" ? t("mongoDiag.hostkey.title.changed") : mode() === "unscannable" ? t("mongoDiag.hostkey.title.unscannable") : t("mongoDiag.hostkey.title.unknown"));

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={title()}
      size="md"
      role={mode() === "changed" ? "alertdialog" : "dialog"}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" data-autofocus onClick={props.onClose}>{mode() === "unscannable" ? t("mongoDiag.hostkey.close") : t("mongoDiag.hostkey.cancel")}</Button>
          <Show when={mode() === "unknown" && props.view}>
            <Button variant="primary" loading={busy()} onClick={() => void run("trust", () => props.onTrust(props.view!))}>{t("mongoDiag.hostkey.trust")}</Button>
          </Show>
        </>
      }
    >
      <div class="mgk" data-mode={mode()}>
        <dl class="mgk__meta">
          <dt>{t("mongoDiag.hostkey.server")}</dt>
          <dd dir="ltr" class="mgk__mono">{hostLabel()}</dd>
          <Show when={props.view}>
            <dt>{t("mongoDiag.hostkey.keyType")}</dt>
            <dd dir="ltr" class="mgk__mono">{props.view!.keyType}</dd>
          </Show>
        </dl>

        <Show when={mode() === "unknown" && props.view}>
          <Fingerprint label={t("mongoDiag.hostkey.fingerprint")} value={props.view!.fingerprint} />
          <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(props.view!.fingerprint)}>{t("mongoDiag.hostkey.copyFingerprint")}</Button>
          <p class="mgk__p">{t("mongoDiag.hostkey.compare")}</p>
          <p class="mgk__note">{t("mongoDiag.hostkey.scope")}</p>
        </Show>

        <Show when={mode() === "changed" && props.view}>
          <p class="mgk__alert" role="alert"><ShieldAlert size={16} aria-hidden="true" />{t("mongoDiag.hostkey.changed.body")}</p>
          <Show when={props.expectedFingerprint}>
            <Fingerprint label={t("mongoDiag.hostkey.expected")} value={props.expectedFingerprint!} />
          </Show>
          <Fingerprint label={t("mongoDiag.hostkey.seen")} value={props.view!.fingerprint} tone="bad" />
          <section class="mgk__forget">
            <h4>{t("mongoDiag.hostkey.forget.title")}</h4>
            <p class="mgk__note">{t("mongoDiag.hostkey.forget.help")}</p>
            <Show
              when={!forgotten()}
              fallback={<p class="mgk__p" role="status">{t("mongoDiag.hostkey.forget.done")}</p>}
            >
              <label for={typedId} class="mgk__label">{t("mongoDiag.hostkey.forget.label", { host: props.view!.host })}</label>
              <Input
                id={typedId}
                value={typed()}
                onInput={(e) => setTyped(e.currentTarget.value)}
                dir="ltr"
                autocomplete="off"
                spellcheck={false}
                autocapitalize="off"
                placeholder={props.view!.host}
              />
              <div class="mgk__row">
                <Button variant="danger" size="sm" loading={busy()} disabled={!forgetConfirmed(typed(), props.view!.host)} onClick={() => void run("forget", () => props.onForget(typed()))}>{t("mongoDiag.hostkey.forget.button")}</Button>
              </div>
            </Show>
          </section>
        </Show>

        <Show when={mode() === "unscannable"}>
          <p class="mgk__p">{t("mongoDiag.hostkey.unscannable.body")}</p>
          <p class="mgk__p">{t("mongoDiag.hostkey.unscannable.step1")}</p>
          <Show when={command()}>
            <div class="mgk__cmd">
              <code dir="ltr">{command()}</code>
              <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(command()!)}>{t("mongoDiag.hostkey.copyCommand")}</Button>
            </div>
          </Show>
          <p class="mgk__p">{t("mongoDiag.hostkey.unscannable.step2")}</p>
        </Show>

        <Show when={failed()}>
          <p class="mgk__fail" role="alert"><TriangleAlert size={14} aria-hidden="true" />{failed() === "trust" ? t("mongoDiag.hostkey.trust.failed") : t("mongoDiag.hostkey.forget.failed")}</p>
        </Show>
      </div>
    </Dialog>
  );
}
