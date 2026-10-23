import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, Checkbox, Dialog, Input } from "../../ui-kit";
import { whatsNewView } from "../whatsnew/state";
import "./account.css";
import { closeDialog, decline, dialog, loadStatus, openPrivacy, openReconsent, openRegister, problemKey, problemOf, reconsent, register, settleMs, status } from "./store";

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

/** What the registry stores, in the words of the notice (`docs/privacy.md`, "Registration and usage details"). */
function Stored() {
  return (
    <>
      <p class="account__lead">{t("account.first.lead")}</p>
      <p class="account__lead">{t("account.first.stores")}</p>
      <ul class="account__list">
        <li>{t("account.first.item.person")}</li>
        <li>{t("account.first.item.computer")}</li>
        <li>{t("account.first.item.use")}</li>
        <li>{t("account.first.item.place")}</li>
      </ul>
      <p class="account__never">{t("account.first.never")}</p>
      <p class="account__where">
        {t("account.first.where", { url: status()?.url ?? "" })}{" "}
        <button type="button" class="account__link" onClick={() => void openPrivacy()}>
          {t("account.first.privacy")}
        </button>
      </p>
    </>
  );
}

function FirstStart() {
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [agree, setAgree] = createSignal(false);
  const [news, setNews] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const [tried, setTried] = createSignal(false);

  const nameBad = createMemo(() => name().trim().length === 0 || name().trim().length > 100);
  const emailBad = createMemo(() => !EMAIL.test(email().trim()));

  const submit = async (e?: Event) => {
    e?.preventDefault();
    setTried(true);
    setError(undefined);
    if (nameBad() || emailBad() || !agree() || busy()) return;
    setBusy(true);
    try {
      await register({ name: name(), email: email(), newsletter: news(), consent: true });
      closeDialog();
    } catch (err) {
      const p = problemOf(err);
      const key = problemKey(p);
      setError(key ? t(key) : t("account.err.generic", { message: p.message }));
    } finally {
      setBusy(false);
    }
  };

  /** "Not now", Escape and the close button are the same answer: nothing is sent, and the screen does not come back by itself. */
  const notNow = () => {
    closeDialog();
    void decline();
  };

  return (
    <Dialog
      open
      onClose={notNow}
      closeOnBackdrop={false}
      size="md"
      title={t("account.first.title")}
      footer={
        <>
          <Button variant="ghost" onClick={notNow} disabled={busy()}>
            {t("account.notNow")}
          </Button>
          <Button variant="primary" loading={busy()} disabled={tried() && (nameBad() || emailBad() || !agree())} onClick={() => void submit()}>
            {t("account.register")}
          </Button>
        </>
      }
    >
      <form class="account" onSubmit={submit} novalidate>
        <Stored />
        <div class="account__fields">
          <div class="account__field">
            <label for="account-name">{t("account.field.name")}</label>
            <Input id="account-name" value={name()} onInput={(e) => setName(e.currentTarget.value)} autocomplete="name" maxLength={100} invalid={tried() && nameBad()} data-autofocus />
            <Show when={tried() && nameBad()}>
              <span class="account__error" role="alert">{t("account.err.name")}</span>
            </Show>
          </div>
          <div class="account__field">
            <label for="account-email">{t("account.field.email")}</label>
            <Input id="account-email" type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} autocomplete="email" maxLength={254} invalid={tried() && emailBad()} />
            <Show when={tried() && emailBad()}>
              <span class="account__error" role="alert">{t("account.err.email")}</span>
            </Show>
          </div>
        </div>
        <div class="account__checks">
          <Checkbox checked={agree()} onChange={setAgree} label={t("account.consent")} />
          <Show when={tried() && !agree()}>
            <span class="account__error" role="alert">{t("account.err.consent")}</span>
          </Show>
          <Checkbox checked={news()} onChange={setNews} label={t("account.newsletter")} />
        </div>
        <Show when={error()}>
          <p class="account__error" role="alert">{error()}</p>
        </Show>
        <button type="submit" hidden aria-hidden="true" tabindex="-1" />
      </form>
    </Dialog>
  );
}

function Again() {
  const [busy, setBusy] = createSignal<"accept" | "stop" | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const answer = async (accept: boolean) => {
    setBusy(accept ? "accept" : "stop");
    setError(undefined);
    try {
      await reconsent(accept);
      closeDialog();
    } catch (err) {
      const p = problemOf(err);
      const key = problemKey(p);
      setError(key ? t(key) : t("account.err.generic", { message: p.message }));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Dialog
      open
      onClose={closeDialog}
      closeOnBackdrop={false}
      size="md"
      title={t("account.again.title")}
      footer={
        <>
          <Button variant="danger" loading={busy() === "stop"} disabled={busy() === "accept"} onClick={() => void answer(false)}>
            {t("account.again.stop")}
          </Button>
          <Button variant="primary" loading={busy() === "accept"} disabled={busy() === "stop"} onClick={() => void answer(true)}>
            {t("account.again.continue")}
          </Button>
        </>
      }
    >
      <div class="account">
        <p class="account__lead">{t("account.again.lead")}</p>
        <Stored />
        <Show when={error()}>
          <p class="account__error" role="alert">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
}

/** Overlay: decides once at start whether the person has to be asked (never asked, or registered under an older notice) and opens the screen for it. */
export default function RegisterDialog() {
  const [due, setDue] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  onMount(() => {
    void loadStatus().then((s) => {
      if (s?.needsConsent) timer = setTimeout(() => setDue(true), settleMs());
    });
  });
  createEffect(() => {
    // not on top of the What's new window, and not while a screen of ours is open
    if (!due() || whatsNewView() || dialog()) return;
    const s = status();
    if (!s?.needsConsent) return setDue(false);
    setDue(false);
    if (s.state === "registered") openReconsent();
    else openRegister();
  });
  return (
    <>
      <Show when={dialog() === "register"}>
        <FirstStart />
      </Show>
      <Show when={dialog() === "reconsent"}>
        <Again />
      </Show>
    </>
  );
}
