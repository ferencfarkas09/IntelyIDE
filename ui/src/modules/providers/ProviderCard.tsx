import { createSignal, createUniqueId, lazy, Show, Suspense } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import { Badge, Button, Input, Select, StatusDot, Switch, toast, TriangleAlert } from "../../ui-kit";
import type { ProviderEnforcement, ProviderInfo, ProviderTest } from "../../ipc/providers";
import { GENERIC_ACP, loginHint, loginNote } from "./catalog";
import { CapsMatrix } from "./CapsMatrix";
import { EnforcementBadge } from "./EnforcementBadge";
import { KeyField } from "./KeyField";
import { ProviderMark } from "./ProviderMark";
import { TestRun } from "./TestRun";
import { SdkCard } from "./SdkCard";
import { authLabel, baseUrlKey, baseUrlProblem, BASE_URL_HINT, cardChip, HAS_BASE_URL, kindLabel, sdkIssue, secretKey } from "./logic";

/** Only an experimental provider that is switched on shows a command line; Claude never fetches this chunk. */
const LaunchPanel = lazy(() => import("./LaunchPanel"));

export interface ProviderCardProps {
  provider: ProviderInfo;
  baseUrl: string;
  /** Recorded attempt-suite results; empty when none ever ran. */
  enforcement: readonly ProviderEnforcement[];
  /** The global `Experimental providers` switch. Without it an experimental provider is off whatever its own switch says. */
  experimentalOn: boolean;
  /** The backend answered with a changed provider (switch, auth mode, key, confirmation). */
  onChange: (next: ProviderInfo) => void;
  /** Re-read this provider (after a key was stored or removed). */
  onRefresh: () => Promise<void>;
}

export function ProviderCard(props: ProviderCardProps) {
  const id = createUniqueId();
  const [test, setTest] = createSignal<ProviderTest | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [url, setUrl] = createSignal<string | null>(null);
  const [negotiated, setNegotiated] = createSignal(0);
  const p = () => props.provider;
  const chip = () => cardChip(p());
  const sdk = () => sdkIssue(p());
  const mode = () => p().authModes.find((m) => m.id === p().authMode);
  const urlValue = () => url() ?? props.baseUrl;
  const urlProblem = () => baseUrlProblem(urlValue());
  /** Does this card run at all: the switch, and for an experimental provider the global switch too. */
  const active = () => p().enabled && (!p().experimental || props.experimentalOn);
  /** An experimental provider whose program was looked for and is not there cannot be switched on. */
  const missing = () => p().experimental && !!p().cli && !p().cli?.path && !p().enabled;
  const cannotSwitch = () => (p().experimental && !props.experimentalOn) || missing();
  const writerAllowed = () => p().experimental && p().allowWeakWriter;

  const guard = async <T,>(what: Parameters<typeof t>[0], run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (e) {
      toast.error(t("providers.fail.title", { name: p().name, what: t(what) }), errorText(e));
      return undefined;
    }
  };

  async function toggle(on: boolean) {
    setTest(null);
    const next = await guard("providers.fail.switching", () => ipc.providers.setEnabled(p().id, on));
    if (next) props.onChange(next);
  }

  async function chooseMode(modeId: string) {
    setTest(null);
    const next = await guard("providers.fail.signIn", () => ipc.providers.setAuthMode(p().id, modeId));
    if (next) props.onChange(next);
  }

  async function runTest() {
    setTesting(true);
    const result = await guard("providers.fail.test", () => ipc.providers.test(p().id));
    setTesting(false);
    if (result) setTest(result);
    await props.onRefresh();
  }

  async function saveUrl() {
    if (url() === null || urlProblem()) return;
    await guard("providers.fail.address", () => ipc.settings.set("providers", { [baseUrlKey(p().id)]: url()!.trim() || null }));
    setUrl(null);
  }

  return (
    <article class="pcard" data-state={active() ? p().state : "off"} aria-labelledby={`${id}-name`}>
      <header class="pcard__head">
        <ProviderMark id={p().id} size={28} class="pcard__icon" />
        <span class="pcard__title">
          <h4 class="pcard__name" id={`${id}-name`}>{p().name}</h4>
          <span class="pcard__kind">{GENERIC_ACP.has(p().id) ? t("providers.kind.generic") : kindLabel(p().kind)}</span>
        </span>
        <Badge tone={chip().tone} title={p().message ?? undefined}>
          <StatusDot tone={chip().tone} />
          {chip().label}
        </Badge>
        <span class="pcard__switch" title={missing() ? t("providers.card.cannotEnable", { name: p().name }) : p().experimental && !props.experimentalOn ? t("providers.card.needsExp") : undefined}>
          <Switch aria-label={t("providers.card.enable", { name: p().name })} checked={p().enabled} disabled={cannotSwitch()} onChange={(on) => void toggle(on)} />
        </span>
      </header>

      <Show
        when={active()}
        fallback={
          <p class="pcard__off">
            {missing() ? t("providers.card.cannotEnable", { name: p().name }) : p().enabled && p().experimental ? t("providers.card.needsExp") : t("providers.card.off", { name: p().name })}
          </p>
        }
      >
        <dl class="pcard__facts">
          <Show when={(p().cli || p().kind !== "api") && p().id !== "acp"}>
            <dt>{t("providers.card.version")}</dt>
            <dd>
              {p().cli?.version ?? (p().cli ? t("providers.card.unknown") : t("providers.card.notDetected"))}
              <Show when={p().cli?.meetsMin === false}>
                <Badge tone="warn" size="sm" icon={TriangleAlert} title={t("providers.card.minSupported", { min: p().cli?.minVersion ?? "" })}>{t("providers.card.belowMin")}</Badge>
              </Show>
            </dd>
          </Show>
          <Show when={p().cli?.path}>
            <dt>{t("providers.card.program")}</dt>
            <dd class="pcard__mono">{p().cli?.path}</dd>
          </Show>
          <Show when={p().message && p().state !== "ready" && !sdk()}>
            <dt>{t("providers.card.status")}</dt>
            <dd>{p().message}</dd>
          </Show>
          <Show when={loginHint(p().id)}>
            <dt>{t("providers.card.login")}</dt>
            <dd class="pcard__hint" data-needed={p().state === "needsLogin" || p().state === "needsKey" ? "" : undefined}>
              {loginHint(p().id)} <span class="pcard__note">{loginNote()}</span>
            </dd>
          </Show>
        </dl>

        <Show when={sdk()}>{(issue) => <SdkCard issue={issue()} onChange={props.onChange} />}</Show>

        <Show when={p().experimental && p().launch}>
          <Suspense>
            <LaunchPanel provider={p()} onChange={props.onChange} />
          </Suspense>
        </Show>

        <div class="pcard__controls">
          <Show when={p().authModes.length > 1}>
            <label class="pcard__field">
              <span>{t("providers.card.signIn")}</span>
              <Select
                size="sm"
                aria-label={t("providers.card.signInAria", { name: p().name })}
                // an experimental provider has no key hand-over to its agent yet: key modes are listed, not selectable
                options={p().authModes.map((m) => ({ value: m.id, label: p().experimental && m.needsKey ? t("providers.card.keyNotWired", { label: authLabel(m) }) : authLabel(m), disabled: p().experimental && m.needsKey && m.id !== p().authMode }))}
                value={p().authMode}
                onChange={(m) => void chooseMode(m)}
              />
            </label>
          </Show>
          <Show when={mode()?.needsKey && !p().experimental}>
            <div class="pcard__field">
              <span>{authLabel(mode()!)}</span>
              <KeyField
                kind={mode()!.id === "token" ? "token" : "apiKey"}
                hasKey={p().hasKey}
                onSave={async (value) => {
                  await guard("providers.fail.storeKey", () => ipc.secrets.set(secretKey(p().id), value));
                  await props.onRefresh();
                }}
                onRemove={async () => {
                  await guard("providers.fail.removeKey", () => ipc.secrets.remove(secretKey(p().id)));
                  await props.onRefresh();
                }}
              />
            </div>
          </Show>
          <Show when={HAS_BASE_URL.has(p().id)}>
            <label class="pcard__field">
              <span>{t("providers.card.address")}</span>
              <Input
                size="sm"
                aria-label={t("providers.card.addressAria", { name: p().name })}
                placeholder={BASE_URL_HINT[p().id]}
                autocomplete="off"
                spellcheck={false}
                value={urlValue()}
                invalid={!!urlProblem()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                onBlur={() => void saveUrl()}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void saveUrl())}
              />
              <Show when={urlProblem()}>
                <small class="pcard__problem" role="alert">{urlProblem() === "insecure" ? t("providers.card.addressHttps") : t("providers.card.addressFull", { example: BASE_URL_HINT[p().id] })}</small>
              </Show>
            </label>
          </Show>
        </div>

        <footer class="pcard__foot">
          <EnforcementBadge provider={p().id} name={p().name} list={props.enforcement} installed={p().cli?.version} writerAllowed={writerAllowed()} />
          <Show when={p().id !== "claude"}>
            <span class="pcard__rule">{writerAllowed() ? t("providers.card.writerAllowed") : t("providers.card.readOnlyRule")}</span>
          </Show>
          <span class="pcard__spacer" />
          <Show when={test()}>
            {(r) => (
              <span class="pcard__result" role="status" data-ok={r().ok ? "" : undefined}>
                {r().ok ? t("providers.card.works") : t("providers.card.failed")}: {r().message}
                <Show when={r().latencyMs != null}> ({t("providers.card.latency", { ms: r().latencyMs ?? 0 })})</Show>
              </span>
            )}
          </Show>
          <CapsMatrix id={p().id} name={p().name} refreshKey={negotiated()} />
          <TestRun provider={p().id} name={p().name} disabled={p().state !== "ready"} disabledReason={t("providers.testRun.unavailable")} onNegotiated={() => setNegotiated((n) => n + 1)} />
          <Button size="sm" loading={testing()} onClick={() => void runTest()}>{t("providers.card.testConnection")}</Button>
        </footer>
      </Show>
    </article>
  );
}
