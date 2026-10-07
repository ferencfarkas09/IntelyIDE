import { createSignal, For, Show } from "solid-js";
import { t } from "../../../i18n";
import type { ProfileView, SecretKind, SessionSecrets } from "../../../ipc/mongo";
import { Button, Dialog } from "../../../ui-kit";
import { createProductionGate } from "../loudChip";
import { PasswordPrompt } from "../PasswordPrompt";
import { connect, hasRemembered, stateOf } from "../store";
import { endpointsOf, isAuthFailure, needsEndpointConfirm } from "./logic";

interface Ask<T> {
  p: ProfileView;
  resolve: (v: T) => void;
}

/**
 * The connect flow of one screen: the one-time endpoint confirmation (a never-used profile that reaches beyond loopback), the
 * production confirmation (default button Cancel), the password prompt (S9) and the connect itself. Rules:
 * - a second click while a connect is running is ignored;
 * - a remembered secret that the server rejects is dropped by the store and the prompt reappears ONCE, never in a loop;
 * - nothing here reconnects by itself.
 * Render `dialogs()` once next to the caller.
 */
export function createConnector(opts: { onConnected?: (p: ProfileView) => void } = {}) {
  const production = createProductionGate();
  const [prompt, setPrompt] = createSignal<(Ask<{ secrets: SessionSecrets; remember: boolean } | undefined> & { kinds: SecretKind[]; wrong: boolean }) | undefined>();
  const [endpoints, setEndpoints] = createSignal<Ask<boolean> | undefined>();
  const running = new Set<string>();

  const askSecrets = (p: ProfileView, kinds: SecretKind[], wrong: boolean) => new Promise<{ secrets: SessionSecrets; remember: boolean } | undefined>((resolve) => setPrompt({ p, kinds, wrong, resolve }));
  const askEndpoints = (p: ProfileView) => new Promise<boolean>((resolve) => setEndpoints({ p, resolve }));

  async function attempt(p: ProfileView, typed: { secrets: SessionSecrets; remember: boolean } | undefined, asked: boolean): Promise<boolean> {
    const hadRemembered = hasRemembered(p.id);
    if (await connect(p.id, typed)) return true;
    const st = stateOf(p.id);
    if (asked) return false;
    if (st.needs?.length) {
      const answer = await askSecrets(p, st.needs, false);
      return answer ? attempt(p, answer, true) : false;
    }
    // The store dropped the remembered secret on the rejected sign-in: ask again, once.
    if (hadRemembered && !hasRemembered(p.id) && isAuthFailure(st.error)) {
      const answer = await askSecrets(p, ["password"], true);
      return answer ? attempt(p, answer, true) : false;
    }
    return false;
  }

  async function start(p: ProfileView): Promise<boolean> {
    if (running.has(p.id) || stateOf(p.id).status === "connecting") return false;
    running.add(p.id);
    try {
      if (needsEndpointConfirm(p) && !(await askEndpoints(p))) return false;
      if (!(await production.guard(p))) return false;
      const ok = await attempt(p, undefined, false);
      if (ok) opts.onConnected?.(p);
      return ok;
    } finally {
      running.delete(p.id);
    }
  }

  const dialogs = () => (
    <>
      {production.dialog()}
      <Show when={prompt()} keyed>
        {(a) => (
          <PasswordPrompt
            profile={a.p}
            kinds={a.kinds}
            wrong={a.wrong}
            onSubmit={(secrets, remember) => (setPrompt(undefined), a.resolve({ secrets, remember }))}
            onCancel={() => (setPrompt(undefined), a.resolve(undefined))}
          />
        )}
      </Show>
      <Show when={endpoints()} keyed>
        {(a) => <EndpointConfirm profile={a.p} onAnswer={(ok) => (setEndpoints(undefined), a.resolve(ok))} />}
      </Show>
    </>
  );

  return { start, dialogs, busy: (id: string) => running.has(id) };
}

/** The first connect of a profile that can reach beyond loopback lists every endpoint it will contact. Default: Cancel. */
export function EndpointConfirm(props: { profile: ProfileView; onAnswer: (ok: boolean) => void }) {
  const list = () => endpointsOf(props.profile.spec);
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      closeOnBackdrop={false}
      onClose={() => props.onAnswer(false)}
      title={t("mongoManage.endpoints.title", { name: props.profile.name })}
      description={t("mongoManage.endpoints.body")}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={() => props.onAnswer(false)}>{t("mongoManage.cancel")}</Button>
          <Button variant="primary" onClick={() => props.onAnswer(true)}>{t("mongoManage.endpoints.connect")}</Button>
        </>
      }
    >
      <ul class="mm-endpoints" aria-label={t("mongoManage.endpoints.list")}>
        <For each={list()}>{(e) => <li class="ui-mono" dir="ltr">{e}</li>}</For>
      </ul>
      <Show when={props.profile.spec?.tunnel?.kind === "ssh"}><p class="mm-hint">{t("mongoManage.endpoints.agent")}</p></Show>
    </Dialog>
  );
}
