import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TeamJoinPreview } from "../../ipc/team";
import { Button, Checkbox, Input, Spinner, TextArea, UserPlus } from "../../ui-kit";
import { openSettings } from "../../platform/settings";
import { consumeInvite, pendingInvite } from "./inviteLink";
import { isRelayOld, joinMessageOf, joinTeam } from "./store";

const DEBOUNCE_MS = 300;
const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** What the pasted text is: not looked at yet, being read, an invite, or not an invite. */
type Preview = { state: "idle" } | { state: "checking" } | { state: "ok"; info: TeamJoinPreview } | { state: "invalid"; message: string };

/** Settings > Team > Join: the invite code, what it points to (read on this Mac, no network), the trust step for a relay, and the name. */
export function JoinCard(props: { name: string; onName: (v: string) => void }) {
  const [code, setCode] = createSignal("");
  const [preview, setPreview] = createSignal<Preview>({ state: "idle" });
  const [trust, setTrust] = createSignal(false);
  /** The backend refused the relay although the preview said it was trusted: ask for the trust anyway. */
  const [forceTrust, setForceTrust] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [relayOld, setRelayOld] = createSignal(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticket = 0;
  onCleanup(() => clearTimeout(timer));

  createEffect(
    on(code, (text) => {
      clearTimeout(timer);
      const mine = ++ticket;
      setTrust(false);
      setForceTrust(false);
      setError(undefined);
      if (!text.trim()) return setPreview({ state: "idle" });
      setPreview({ state: "checking" });
      timer = setTimeout(() => {
        ipc.team.joinPreview(text).then(
          (info) => mine === ticket && setPreview({ state: "ok", info }),
          // not an invite at all gets the hint how to paste one; an invite whose relay address is refused says why
          (e) => mine === ticket && setPreview({ state: "invalid", message: codeOf(e) === "invalidCode" ? t("team.join.invalid") : joinMessageOf(e) }),
        );
      }, DEBOUNCE_MS);
    }),
  );

  // an invite link that was clicked (or opened the app): its code goes into the field, and the preview below reads it like a pasted one
  createEffect(() => {
    if (pendingInvite() === undefined) return;
    const text = consumeInvite();
    if (text) setCode(text);
  });

  const info = () => {
    const p = preview();
    return p.state === "ok" ? p.info : undefined;
  };
  const invalidMessage = () => {
    const p = preview();
    return p.state === "invalid" ? p.message : undefined;
  };
  /** Whether the person has to say they trust the relay. */
  const needsTrust = () => !!info() && (!info()!.trusted || forceTrust());
  const ready = () => !!props.name.trim() && !!info() && (!needsTrust() || trust());

  const go = async () => {
    setBusy(true);
    setError(undefined);
    setRelayOld(false);
    try {
      await joinTeam(code(), props.name, needsTrust() && trust());
    } catch (e) {
      setError(joinMessageOf(e));
      setRelayOld(isRelayOld(e));
      if (codeOf(e) === "hostNotAllowed") setForceTrust(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="team-card">
      <h5 class="team-card__title">{t("team.join.title")}</h5>
      <p class="team-note">{t("team.join.body")}</p>
      <TextArea aria-label={t("team.join.code")} placeholder={t("team.join.codePh")} minRows={2} maxRows={4} spellcheck={false} value={code()} onInput={(e) => setCode(e.currentTarget.value)} />
      <Show when={preview().state === "checking"}>
        <p class="team-wait" data-testid="join-checking"><Spinner size={12} />{t("team.join.checking")}</p>
      </Show>
      <Show when={invalidMessage()}>
        {(m) => <p class="team-error" role="alert" data-testid="join-invalid">{m()}</p>}
      </Show>
      <Show when={info()}>
        {(i) => (
          <div class="team-preview" data-testid="join-preview">
            <p class="team-preview__relay">{t("team.join.relay", { host: i().relayHost })}</p>
            <p class="team-note">{t("team.join.team", { team: i().teamId, admin: i().adminId })}</p>
            <Show
              when={needsTrust()}
              fallback={<p class="team-note" data-testid="join-trusted">{t(i().local ? "team.join.local" : "team.join.trusted")}</p>}
            >
              <Checkbox size="sm" checked={trust()} onChange={setTrust} label={t("team.join.trust", { host: i().relayHost })} />
              <p class="team-note">{t("team.join.trustNote")}</p>
            </Show>
          </div>
        )}
      </Show>
      <Input size="sm" aria-label={t("team.name.label")} placeholder={t("team.name.ph")} maxLength={60} value={props.name} onInput={(e) => props.onName(e.currentTarget.value)} />
      <div class="team-actions">
        <Button size="sm" variant="primary" icon={UserPlus} loading={busy()} disabled={!ready()} onClick={() => void go()}>
          {t("team.join.go")}
        </Button>
      </div>
      <Show when={error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
      <Show when={relayOld()}><Button size="sm" variant="secondary" onClick={() => openSettings("remote")}>{t("team.err.openRemote")}</Button></Show>
    </div>
  );
}
