import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ConnectionTest, Env, HappyStatus, PrefsPatch, ProviderStatus } from "../../ipc/happy";
import { applyHappyStatus, happyStatus, refreshHappyStatus } from "../../store/happy";
import { Badge, Button, Clock, Eye, EyeOff, FormGroup, FormRow, IconButton, Inbox, Input, ListChecks, MessageSquare, SegmentedControl, StatusDot, Switch, toast, Video } from "../../ui-kit";
import { connectionLine, errorLine, hostOf, looksLikeToken, STATE_CHIP, storeLabel } from "./logic";
import "./integrations.css";

const ENVS: { value: Env; label: string }[] = [
  { value: "production", get label() { return t("integrations.env.production"); } },
  { value: "sandbox", get label() { return t("integrations.env.sandbox"); } },
  { value: "custom", get label() { return t("integrations.env.custom"); } },
];

const PROVIDERS = [
  { id: "timer" as const, name: "Time Tracer", icon: Clock, get text() { return t("integrations.p.timer.text"); } },
  { id: "meet" as const, name: "Meet", icon: Video, get text() { return t("integrations.p.meet.text"); } },
  { id: "chat" as const, get name() { return t("integrations.p.chat.name"); }, icon: MessageSquare, get text() { return t("integrations.p.chat.text"); } },
  { id: "notifications" as const, get name() { return t("integrations.p.notifications.name"); }, icon: Inbox, get text() { return t("integrations.p.notifications.text"); } },
  { id: "tasks" as const, get name() { return t("integrations.p.tasks.name"); }, icon: ListChecks, get text() { return t("integrations.p.tasks.text"); } },
];

const message = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

export default function IntegrationsSection() {
  const status = happyStatus;
  const [draft, setDraft] = createSignal("");
  const [reveal, setReveal] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [result, setResult] = createSignal<ConnectionTest>();
  const [problem, setProblem] = createSignal<string>();
  const [customMode, setCustomMode] = createSignal(false);
  const [customUrl, setCustomUrl] = createSignal("");

  onMount(() => {
    void refreshHappyStatus().then((s) => {
      if (s.config.env !== "custom") return;
      setCustomMode(true);
      setCustomUrl(s.config.customBaseUrl ?? "");
    });
    const off = ipc.happy.onState(applyHappyStatus);
    onCleanup(off);
  });

  const cfg = () => status()?.config;
  const apply = async (op: () => Promise<HappyStatus>): Promise<boolean> => {
    setProblem(undefined);
    try {
      applyHappyStatus(await op());
      // The reply is a snapshot from when the call ran; a state pushed since (a 403 on the first poll) can have arrived before it, so read again.
      void refreshHappyStatus().catch(() => {});
      return true;
    } catch (e) {
      setProblem(message(e));
      return false;
    }
  };
  const setProvider = (id: "timer" | "meet" | "chat" | "notifications" | "tasks", patch: PrefsPatch) => void apply(() => ipc.happy.setConfig({ [id]: patch }));
  const chooseEnv = (env: Env) => {
    setResult(undefined);
    if (env === "custom") {
      setCustomMode(true);
      if (customUrl().trim()) void commitCustom();
      return;
    }
    setCustomMode(false);
    void apply(() => ipc.happy.setConfig({ env }));
  };
  const commitCustom = async () => {
    if (!customUrl().trim()) return;
    if (await apply(() => ipc.happy.setConfig({ env: "custom", customBaseUrl: customUrl() }))) setResult(undefined);
  };

  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      const r = await ipc.happy.saveToken(draft());
      setResult(r);
      if (r.ok) {
        setDraft("");
        setReveal(false);
        toast.show({ title: t("integrations.connectedAs", { name: r.user?.name ?? t("integrations.happyUser") }), tone: "ok", duration: 3000 });
      }
      await refreshHappyStatus();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setProblem(undefined);
    try {
      setResult(await ipc.happy.testConnection());
      await refreshHappyStatus();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setTesting(false);
    }
  };
  const disconnect = async () => {
    setResult(undefined);
    await apply(ipc.happy.disconnect);
  };

  const line = () => connectionLine(status(), Date.now());
  const provider = (id: string): ProviderStatus | undefined => status()?.providers.find((p) => p.id === id);
  const customHost = () => hostOf(customUrl());

  return (
    <div class="int">
      <FormGroup title={t("integrations.account")} description={t("integrations.accountDesc")}>
        <FormRow label={t("integrations.environment")}>
          <SegmentedControl aria-label={t("integrations.environment")} size="sm" options={ENVS} value={customMode() ? "custom" : (cfg()?.env ?? "sandbox")} onChange={chooseEnv} />
        </FormRow>
        <Show when={customMode()}>
          <FormRow label={t("integrations.baseUrl")} labelFor="happy-base-url" description={customHost() ? t("integrations.baseUrlHost", { host: customHost()! }) : t("integrations.baseUrlHint")} stacked>
            <Input
              id="happy-base-url"
              size="sm"
              wrapperClass="int__wide"
              value={customUrl()}
              placeholder="https://happy.example.com"
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setCustomUrl(e.currentTarget.value)}
              onChange={() => void commitCustom()}
              onKeyDown={(e) => e.key === "Enter" && void commitCustom()}
            />
          </FormRow>
        </Show>
        <FormRow label={t("integrations.token")} labelFor="happy-token" description={status()?.tokenSaved ? t("integrations.tokenSaved") : t("integrations.tokenPaste")} stacked>
          <div class="int__token">
            <Input
              id="happy-token"
              size="sm"
              type={reveal() ? "text" : "password"}
              value={draft()}
              placeholder={status()?.tokenSaved ? "••••••••••••••••" : "eyJ…"}
              spellcheck={false}
              autocomplete="off"
              invalid={draft().length > 0 && !looksLikeToken(draft())}
              trailing={<IconButton icon={reveal() ? EyeOff : Eye} label={reveal() ? t("integrations.hideToken") : t("integrations.showToken")} size="sm" onClick={() => setReveal(!reveal())} />}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && looksLikeToken(draft()) && void save()}
            />
            <Button variant="primary" size="sm" loading={saving()} disabled={!looksLikeToken(draft())} onClick={() => void save()}>{t("integrations.saveToken")}</Button>
          </div>
        </FormRow>
        <FormRow label={t("integrations.connection")} stacked>
          <div class="int__conn">
            <p class="int__line" data-tone={line().tone} role="status">
              <StatusDot tone={line().tone === "neutral" ? "neutral" : line().tone} size={6} />
              <span>{line().text}</span>
            </p>
            <div class="int__buttons">
              <Button size="sm" loading={testing()} disabled={!status()?.tokenSaved} onClick={() => void test()}>{t("integrations.test")}</Button>
              <Button size="sm" variant="ghost" disabled={!status()?.tokenSaved} onClick={() => void disconnect()}>{t("integrations.disconnect")}</Button>
            </div>
            <Show when={result()}>
              {(r) => (
                <div class="int__result" data-ok={r().ok ? "" : undefined} role="status">
                  <Show when={r().ok} fallback={<p class="int__fail">{r().message}</p>}>
                    <dl class="int__facts">
                      <dt>{t("integrations.user")}</dt><dd>{r().user?.name ?? "—"}</dd>
                      <Show when={storeLabel(r().user)}><dt>{t("integrations.store")}</dt><dd>{storeLabel(r().user)}</dd></Show>
                      <For each={r().providers}>
                        {(p) => (
                          <>
                            <dt>{PROVIDERS.find((x) => x.id === p.id)?.name ?? p.id}</dt>
                            <dd data-denied={p.allowed ? undefined : ""}>{p.allowed ? t("integrations.allowed") : (p.hint ?? t("integrations.notAllowed"))}</dd>
                          </>
                        )}
                      </For>
                    </dl>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={problem()}><p class="int__fail" role="alert">{problem()}</p></Show>
          </div>
        </FormRow>
      </FormGroup>

      <FormGroup title={t("integrations.title")}>
        <FormRow label={t("integrations.master")} description={t("integrations.masterDesc")}>
          <Switch aria-label={t("integrations.master")} checked={!!cfg()?.master} disabled={!cfg()} onChange={(master) => void apply(() => ipc.happy.setConfig({ master }))} />
        </FormRow>
        <For each={PROVIDERS}>
          {(p) => {
            const prefs = () => cfg()?.[p.id];
            const st = () => provider(p.id);
            const chip = () => STATE_CHIP[st()?.state ?? "off"];
            return (
              <div class="int__provider" data-off={!cfg()?.master ? "" : undefined}>
                <FormRow label={p.name} description={p.text}>
                  <div class="int__switch">
                    <Badge tone={chip().tone} size="sm">{chip().label}</Badge>
                    <Switch aria-label={t("integrations.onOff", { name: p.name })} checked={!!prefs()?.enabled} disabled={!cfg()} onChange={(enabled) => setProvider(p.id, { enabled })} />
                  </div>
                </FormRow>
                <Show when={prefs()?.enabled}>
                  <div class="int__details">
                    <Switch size="sm" label={t("integrations.showInStatusBar")} checked={!!prefs()?.showInStatusBar} onChange={(showInStatusBar) => setProvider(p.id, { showInStatusBar })} />
                    <Show when={p.id !== "tasks"}>
                      <Switch size="sm" label={t(`integrations.allow.${p.id}` as "integrations.allow.timer")} checked={!!prefs()?.allowActions} onChange={(allowActions) => setProvider(p.id, { allowActions })} />
                    </Show>
                    <Show when={errorLine(st()?.lastError)}>{(text) => <p class="int__fail">{text()}</p>}</Show>
                    <Show when={st()?.state === "waitingForToken"}><p class="int__note">{t("integrations.waiting")}</p></Show>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </FormGroup>
    </div>
  );
}
