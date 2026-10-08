import { createSignal, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, FormGroup, FormRow, Input } from "../../ui-kit";
import { problemOf, sentryApi } from "./api";
import { problemText } from "./SentryTab";
import { loadStatus, reload, setConfigStatus, status } from "./store";
import type { SentryConnection } from "./types";

/** Settings > Sentry: the address, the organization, the token (it stays in the Keychain) and a connection test. */
export default function SentrySection() {
  const [base, setBase] = createSignal("");
  const [org, setOrg] = createSignal("");
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal<string | undefined>(undefined);
  const [result, setResult] = createSignal<SentryConnection | undefined>(undefined);
  const [saved, setSaved] = createSignal(false);
  /** The address changed and the token that belonged to the old one was removed (a token only works for the Sentry it was made in). */
  const [tokenDropped, setTokenDropped] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);

  onMount(() => {
    void loadStatus().then((s) => {
      if (!s) return;
      setBase(s.baseUrl);
      setOrg(s.org);
    });
  });

  const guard = async (what: string, job: () => Promise<void>) => {
    setBusy(what);
    setError(undefined);
    try {
      await job();
    } catch (e) {
      setError(problemText(problemOf(e)));
    } finally {
      setBusy(undefined);
    }
  };

  const saveConfig = () =>
    guard("config", async () => {
      const hadToken = !!status()?.hasToken;
      const next = await sentryApi().setConfig({ baseUrl: base().trim(), org: org().trim() });
      setConfigStatus(next);
      setTokenDropped(hadToken && !next.hasToken);
      setBase(next.baseUrl);
      setOrg(next.org);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      if (next.configured) void reload();
    });

  const saveToken = () =>
    guard("token", async () => {
      const r = await sentryApi().saveToken(token());
      setResult(r);
      setTokenDropped(false);
      if (r.ok || r.problem?.code !== "unauthorized") setToken("");
      setConfigStatus(await sentryApi().status());
      if (r.ok) void reload();
    });

  const test = () =>
    guard("test", async () => {
      setResult(await sentryApi().test());
    });

  const clear = () =>
    guard("clear", async () => {
      setConfigStatus(await sentryApi().clearToken());
      setResult(undefined);
      setTokenDropped(false);
    });

  return (
    <FormGroup title={t("sentry.section.title")} description={t("sentry.section.desc")}>
      <FormRow label={t("sentry.section.base")} description={t("sentry.section.baseDesc")}>
        <Input size="sm" value={base()} placeholder="https://sentry.io" aria-label={t("sentry.section.base")} onInput={(e) => setBase(e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t("sentry.section.org")} description={t("sentry.section.orgDesc")}>
        <Input size="sm" value={org()} placeholder="acme" aria-label={t("sentry.section.org")} onInput={(e) => setOrg(e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t("sentry.section.save")} description={saved() ? t("sentry.section.saved") : undefined}>
        <Button size="sm" variant="secondary" loading={busy() === "config"} onClick={() => void saveConfig()}>{t("sentry.section.save")}</Button>
      </FormRow>
      <FormRow label={t("sentry.section.token")} description={status()?.hasToken ? t("sentry.section.hasToken") : tokenDropped() ? t("sentry.section.tokenDropped") : t("sentry.section.noToken")}>
        <div class="sentry-token">
          <Input size="sm" type="password" autocomplete="off" value={token()} placeholder={status()?.hasToken ? "••••••••••••" : t("sentry.section.tokenPlaceholder")} aria-label={t("sentry.section.token")} onInput={(e) => setToken(e.currentTarget.value)} />
          <Button size="sm" variant="secondary" loading={busy() === "token"} aria-disabled={token().trim() === ""} onClick={() => token().trim() !== "" && void saveToken()}>{t("sentry.section.saveToken")}</Button>
          <Show when={status()?.hasToken}>
            <Button size="sm" variant="ghost" loading={busy() === "clear"} onClick={() => void clear()}>{t("sentry.section.removeToken")}</Button>
          </Show>
        </div>
      </FormRow>
      <FormRow label={t("sentry.section.test")} description={t("sentry.section.scopes")}>
        <Button size="sm" variant="secondary" loading={busy() === "test"} aria-disabled={!status()?.configured} onClick={() => status()?.configured && void test()}>{t("sentry.section.test")}</Button>
      </FormRow>
      <Show when={result()}>
        {(r) => (
          <p class="sentry-result" data-ok={r().ok ? "" : undefined} role="status">
            <Show when={r().ok} fallback={r().problem ? problemText(r().problem!) : t("sentry.problem.unknown")}>
              {r().user ? t("sentry.section.connectedAs", { org: r().orgName ?? "", user: r().user ?? "" }) : t("sentry.section.connected", { org: r().orgName ?? "" })}
              <Show when={!r().user}>
                <span class="sentry-result__warn"> {t("sentry.section.notPerson")}</span>
              </Show>
            </Show>
          </p>
        )}
      </Show>
      <Show when={error()}>{(e) => <p class="sentry-result" role="alert">{e()}</p>}</Show>
    </FormGroup>
  );
}
