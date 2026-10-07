import { createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import type { ProfileView, SecretKind, SessionSecrets } from "../../ipc/mongo";
import { Button, Checkbox, Dialog, Eye, EyeOff, IconButton, Input, Lock, TriangleAlert } from "../../ui-kit";
import "./manage.css";

export interface PasswordPromptProps {
  profile: ProfileView;
  /** The secrets this destination needs and the profile does not store (from the `needs:` list of the refusal). */
  kinds: readonly SecretKind[];
  /** The remembered secret was rejected by the server and has been dropped: say so, once. */
  wrong?: boolean;
  onSubmit: (secrets: SessionSecrets, remember: boolean) => void;
  onCancel: () => void;
}

/** What the secret will be sent to: the hosts (through the tunnel when there is one), the sign-in method and the TLS state. */
export function destinationOf(p: Pick<ProfileView, "spec" | "host">): string {
  const sp = p.spec;
  if (!sp) return p.host;
  const hosts = (sp.hosts ?? []).map((h) => (h.port ? `${h.host}:${h.port}` : h.host)).filter(Boolean).join(", ") || p.host;
  const via = sp.tunnel?.kind === "ssh" ? t("mongoForm.dest.viaSsh", { host: sp.tunnel.host }) : sp.tunnel?.kind === "socks5" ? t("mongoForm.dest.viaProxy", { host: sp.tunnel.host }) : "";
  const tls = sp.tls?.mode === "off" ? t("mongoForm.tls.state.off") : sp.tls?.mode === "on" || sp.scheme === "srv" ? t("mongoForm.tls.state.on") : t("mongoForm.tls.state.auto");
  const mechanism = t(`mongoForm.mech.${sp.auth?.mechanism ?? "default"}`);
  return via ? t("mongoForm.dest.lineVia", { hosts, via, mechanism, tls }) : t("mongoForm.dest.line", { hosts, mechanism, tls });
}

/**
 * S9: the secrets this connection needs and does not store. They go to Rust once and live in memory with the connection;
 * "Remember until I quit" (default on) also keeps them for reconnects, bound to this destination. The page never shows them
 * again, and nothing is written to disk, the URL or web storage.
 */
export function PasswordPrompt(props: PasswordPromptProps) {
  const [values, setValues] = createSignal<Partial<Record<SecretKind, string>>>({});
  const [reveal, setReveal] = createSignal<Partial<Record<SecretKind, boolean>>>({});
  const [remember, setRemember] = createSignal(true);
  const ready = () => props.kinds.every((k) => !!values()[k]);
  // The typed text is dropped when the prompt goes away, whatever the way out.
  onCleanup(() => setValues({}));
  const submit = () => {
    if (!ready()) return;
    const out: SessionSecrets = {};
    for (const k of props.kinds) out[k] = values()[k] as string;
    props.onSubmit(out, remember());
  };
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      closeOnBackdrop={false}
      onClose={props.onCancel}
      title={t("mongoManage.pw.title", { name: props.profile.name })}
      description={t("mongoManage.pw.body")}
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel}>{t("mongoManage.cancel")}</Button>
          <Button variant="primary" disabled={!ready()} onClick={submit}>{t("mongoManage.pw.connect")}</Button>
        </>
      }
    >
      <form class="mm-pw" onSubmit={(e) => (e.preventDefault(), submit())}>
        <Show when={props.wrong}>
          <p class="mm-banner" data-tone="warn" role="alert"><TriangleAlert size={14} aria-hidden="true" /> <span>{t("mongoManage.pw.wrong")}</span></p>
        </Show>
        <For each={props.kinds}>
          {(k, i) => (
            <div class="mm-field">
              <label class="mm-field__label" for={`mm-pw-${k}`}>{t(`mongoManage.pw.kind.${k}`)}</label>
              <Input
                id={`mm-pw-${k}`}
                type={reveal()[k] ? "text" : "password"}
                autocomplete="new-password"
                spellcheck={false}
                autocapitalize="off"
                data-autofocus={i() === 0 ? "" : undefined}
                aria-describedby="mm-pw-dest"
                value={values()[k] ?? ""}
                onInput={(e) => setValues((v) => ({ ...v, [k]: e.currentTarget.value }))}
                trailing={<IconButton icon={reveal()[k] ? EyeOff : Eye} label={reveal()[k] ? t("mongoForm.secret.hide") : t("mongoForm.secret.show")} aria-pressed={!!reveal()[k]} size="sm" onClick={() => setReveal((r) => ({ ...r, [k]: !r[k] }))} />}
              />
            </div>
          )}
        </For>
        <p class="mm-dest" id="mm-pw-dest" dir="auto"><Lock size={12} aria-hidden="true" /> {destinationOf(props.profile)}</p>
        <Checkbox size="sm" checked={remember()} onChange={setRemember} label={t("mongoManage.pw.remember")} />
        <p class="mm-hint">{remember() ? t("mongoManage.pw.rememberOn") : t("mongoManage.pw.rememberOff")}</p>
        <button type="submit" hidden tabindex={-1} aria-hidden="true" />
      </form>
    </Dialog>
  );
}
