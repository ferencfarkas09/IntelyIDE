import { createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import { Badge, EmptyState, Lock, Skeleton, toast, TriangleAlert } from "../../ui-kit";
import type { ProviderEnforcement, ProviderInfo } from "../../ipc/providers";
import { ExperimentalSwitch } from "./ExperimentalSwitch";
import { ProviderCard } from "./ProviderCard";
import { TIER_LABEL, TIER_RANK, TIER_TONE, tierFor, WRITE_MIN_TIER } from "./enforcement";
import { baseUrlKey, replaceProvider } from "./logic";
import "./providers.css";

export default function ProvidersSection() {
  const [providers, setProviders] = createSignal<ProviderInfo[] | null>(null);
  const [urls, setUrls] = createSignal<Record<string, unknown>>({});
  const [error, setError] = createSignal<string | null>(null);
  const [enforcement, setEnforcement] = createSignal<ProviderEnforcement[]>([]);
  const [experimental, setExperimental] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);

  const refresh = async () => setProviders(await ipc.providers.list());

  onMount(async () => {
    try {
      // The cached list first so the cards appear at once, then the detection that Settings > Providers is meant to trigger.
      await refresh();
      void ipc.providers.experimental().then(setExperimental, () => {});
      void ipc.settings.get("providers").then(setUrls, () => {});
      void ipc.providers.enforcement().then(setEnforcement, () => {});
      setProviders(await ipc.providers.detect());
    } catch (e) {
      setError(errorText(e));
    }
  });
  onCleanup(ipc.providers.onState(() => void refresh().catch(() => {})));
  onCleanup(ipc.settings.onChange((e) => e.ns === "providers" && setUrls(e.value)));

  async function switchExperimental(on: boolean) {
    setSwitching(true);
    try {
      setExperimental(await ipc.providers.setExperimental(on));
      await refresh();
    } catch (e) {
      toast.error(t("providers.exp.failed"), errorText(e));
    } finally {
      setSwitching(false);
    }
  }

  const card = (provider: () => ProviderInfo) => (
    <ProviderCard
      provider={provider()}
      baseUrl={String(urls()[baseUrlKey(provider().id)] ?? "")}
      enforcement={enforcement()}
      experimentalOn={experimental()}
      onChange={(next) => setProviders((l) => (l ? replaceProvider(l, next) : l))}
      onRefresh={() => refresh().then(() => {}, () => {})}
    />
  );
  /** Claude always; the experimental providers only while the global switch is on (zero cost when off: no card, no chunk). */
  const shown = createMemo(() => (providers() ?? []).filter((p) => !p.experimental || experimental()));
  const core = createMemo(() => shown().filter((p) => !p.experimental));
  const hidden = createMemo(() => (providers() ?? []).filter((p) => p.experimental).map((p) => p.name));
  /** Providers that actually run: switched on and not held off by the global switch. */
  const running = createMemo(() => shown().filter((p) => p.enabled && p.state !== "off"));
  /** The weakest tier among the running providers: the honest headline, not the best one. */
  const lowest = createMemo(() => running().map((p) => tierFor(enforcement(), p.id, "write").tier).sort((a, b) => TIER_RANK[a] - TIER_RANK[b])[0]);

  return (
    <div class="providers">
      <p class="providers__intro">{t("providers.intro")}</p>
      <Show when={providers() && !error()}>
        <div class="providers__overview" role="status">
          <span>{t("providers.overview.count", { on: running().length, total: (providers() ?? []).length })}</span>
          <Show when={lowest()}>
            {(tier) => (
              <span class="providers__lowest">
                {t("providers.overview.lowest")}
                <Badge size="sm" tone={TIER_TONE[tier()]}>{TIER_LABEL[tier()]}</Badge>
              </span>
            )}
          </Show>
        </div>
      </Show>
      <Show when={!error()} fallback={<EmptyState tone="danger" icon={TriangleAlert} size="sm" title={t("providers.loadFailed")} description={error() ?? ""} />}>
        <Show when={providers()} fallback={<Skeleton height={96} />}>
          <div class="providers__list">
            {/* By position, not by object: every refresh brings new objects, and a card must keep its half-typed key and test result. */}
            <Index each={core()}>{(provider) => card(provider)}</Index>
            <ExperimentalSwitch on={experimental()} busy={switching()} hidden={hidden()} onChange={(on) => void switchExperimental(on)} />
            <Index each={shown().filter((p) => p.experimental)}>{(provider) => card(provider)}</Index>
          </div>
        </Show>
      </Show>
      <section class="providers__safety" aria-labelledby="providers-safety">
        <h4 id="providers-safety" class="providers__safety-title"><Lock size={14} aria-hidden="true" /> {t("providers.safety.title")}</h4>
        <ul>
          <li>{t("providers.safety.write", { tier: TIER_LABEL[WRITE_MIN_TIER] })}</li>
          <li>{t("providers.safety.computed")}</li>
          <li>{t("providers.safety.bypass")}</li>
          <li>{t("providers.safety.never")}</li>
          <li>{t("providers.safety.override")}</li>
        </ul>
      </section>
    </div>
  );
}
