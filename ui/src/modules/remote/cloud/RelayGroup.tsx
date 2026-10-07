import { createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import { Badge, Button, Server, Copy, FormGroup, FormRow, Input, SegmentedControl, ShieldAlert, StatusDot, TriangleAlert } from "../../../ui-kit";
import { ago } from "../logic";
import { applyRemote, refreshRemote, remoteView } from "../state";
import { createApplier } from "./apply";
import { cloudApi } from "./api";
import { CostsNotice, copyText, ErrorSummary, Fingerprint, StatusBadge, TrustNote } from "./common";
import { CustomPanel } from "./Custom";
import { errorCodeOf, framesWarn, FREE_DAILY_FRAMES, staleCheck, VERDICT_KEY, verdictTone, whenText } from "./logic";
import { ManageMenu } from "./Manage";
import { cloudView, refreshCloud } from "./store";
import type { RelayMode } from "./types";
import type { StepId } from "./wizardState";
import { fmt } from "../../../i18n";
import "./cloud.css";

const CloudWizard = lazy(() => import("./Wizard").then((m) => ({ default: m.CloudWizard })));

/** Settings > Remote > Relay: mode, status, bundle, last deploy, manage, costs ((design notes: remote-cloudflare-spec) 3.1). Opening the page
 *  calls `relay_cloud_status` only; nothing is spawned and no socket opens until a button is pressed. */
export default function RelayGroup(props: { onPair: () => void }) {
  const [shown, setShown] = createSignal<RelayMode | null>(null);
  const [wizard, setWizard] = createSignal<{ startAt?: StepId } | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const [code, setCode] = createSignal<string | null>(null);
  const [localUrl, setLocalUrl] = createSignal("");

  onMount(() => {
    void refreshCloud().catch((e) => setCode(errorCodeOf(e)));
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(tick));
  });

  const v = cloudView;
  const mode = (): RelayMode => shown() ?? v()?.mode ?? "local";
  const readOnly = () => v()?.jail === "readOnly";
  const inUse = () => !!v()?.profile && remoteView()?.relay === v()!.profile!.url;

  const useCloud = createApplier("cloudflare", () => v()?.profile?.url ?? null, () => setShown(null));
  const useLocal = createApplier(
    "local",
    () => localUrl().trim() || null,
    () => void refreshRemote(),
    async (confirmUnpair) => {
      await applyRemote(() => ipc.remote.applyLocalRelay(localUrl().trim(), confirmUnpair));
      await refreshCloud().catch(() => {});
    },
  );

  const checkNow = async () => {
    setBusy(true);
    setCode(null);
    try {
      await cloudApi().verify({ target: "deployed" });
      await refreshCloud();
    } catch (e) {
      setCode(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };
  const hostLine = () => {
    const c = v()?.lastCheck;
    if (!c) return t("remote.cloud.status.never");
    if (!c.reachable) return t("remote.cloud.status.down");
    return [t("remote.cloud.status.up"), c.relayVersion ? `v${c.relayVersion}` : null, c.doOk == null ? null : c.doOk ? t("remote.cloud.status.doOk") : t("remote.cloud.status.doBad")].filter(Boolean).join(" · ");
  };
  const frames = () => remoteView()?.relayStats.framesSent ?? 0;

  return (
    <>
      <FormGroup title={t("remote.cloud.group.title")} description={t("remote.cloud.group.desc")}>
        <Show when={readOnly()}>
          <div class="cloud-banner" role="note" data-testid="cloud-readonly">
            <ShieldAlert size={14} /> {t("remote.cloud.readOnly")}
          </div>
        </Show>
        <FormRow label={t("remote.cloud.mode.label")} description={t("remote.cloud.mode.desc")}>
          <SegmentedControl
            aria-label={t("remote.cloud.mode.label")}
            size="sm"
            value={mode()}
            onChange={(m) => setShown(m)}
            options={[
              { value: "local" as RelayMode, label: t("remote.cloud.mode.local") },
              { value: "cloudflare" as RelayMode, label: t("remote.cloud.mode.cloudflare") },
              { value: "custom" as RelayMode, label: t("remote.cloud.mode.custom") },
            ]}
          />
        </FormRow>

        <Show when={mode() === "local"}>
          <FormRow label={t("remote.relay")} description={t("remote.cloud.local.desc")} labelFor="remote-relay" stacked>
            <div class="cloud-row">
              <Input id="remote-relay" size="sm" wrapperClass="cloud-grow" value={localUrl() || remoteView()?.relay || ""} placeholder="ws://127.0.0.1:8787" spellcheck={false} dir="ltr" disabled={readOnly() && false} onInput={(e) => setLocalUrl(e.currentTarget.value)} />
              <Button size="sm" disabled={!localUrl().trim() || localUrl().trim() === remoteView()?.relay} loading={useLocal.busy()} onClick={useLocal.start} data-testid="local-use">
                {t("remote.cloud.useNow")}
              </Button>
            </div>
            <ErrorSummary code={useLocal.code()} />
          </FormRow>
        </Show>

        <Show when={mode() === "custom" && v()}>
          <CustomPanel view={v()!} readOnly={readOnly()} />
        </Show>

        <Show when={mode() === "cloudflare" && v()}>
          <Show
            when={v()!.profile}
            fallback={
              <div class="cloud-stack cloud-pad" data-testid="cloud-empty">
                <Show when={v()!.interrupted}>
                  <p class="cloud-callout" role="note"><TriangleAlert size={14} /> {t("remote.cloud.interrupted")}</p>
                </Show>
                <p class="cloud-note">{t("remote.cloud.setup.desc")}</p>
                <TrustNote />
                <div class="cloud-actions">
                  <Button variant="primary" icon={Server} disabled={readOnly()} onClick={() => setWizard({})} data-testid="setup">
                    {t("remote.cloud.setup.button")}
                  </Button>
                </div>
              </div>
            }
          >
            {(p) => (
              <>
                <FormRow label={t("remote.cloud.row.address")} description={inUse() ? t("remote.cloud.row.inUse") : t("remote.cloud.row.notInUse")} stacked>
                  <div class="cloud-row">
                    <code class="cloud-mono cloud-break" dir="ltr" data-testid="cloud-url">{p().url}</code>
                    <Button size="sm" variant="ghost" icon={Copy} onClick={() => copyText(p().url)} aria-label={t("remote.cloud.copy")} />
                  </div>
                </FormRow>
                <FormRow label={t("remote.cloud.row.status")} description={<span classList={{ "cloud-muted": !!v()!.lastCheck && staleCheck(v()!.lastCheck!.checkedAt, now()) }}>{v()!.lastCheck ? t("remote.cloud.status.checked", { ago: ago(v()!.lastCheck!.checkedAt * 1000, now()) }) : null}</span>}>
                  <div class="cloud-row">
                    <StatusDot tone={v()!.lastCheck?.reachable ? "ok" : v()!.lastCheck ? "danger" : "neutral"} label={hostLine()} />
                    <span data-testid="cloud-status">{hostLine()}</span>
                    <Button size="sm" variant="secondary" loading={busy()} disabled={readOnly()} onClick={() => void checkNow()} data-testid="check-now">
                      {t("remote.cloud.status.checkNow")}
                    </Button>
                  </div>
                </FormRow>
                <FormRow label={t("remote.cloud.row.bundle")} stacked={false}>
                  <Show when={v()!.bundle} fallback={<Badge tone="warn" icon={TriangleAlert}>{t("remote.cloud.bundle.none")}</Badge>}>
                    {(b) => (
                      <div class="cloud-stack cloud-stack--tight cloud-end">
                        <div class="cloud-row">
                          <StatusBadge tone={v()!.lastCheck ? verdictTone(v()!.lastCheck!.verdict) : "neutral"}>
                            {v()!.lastCheck ? t(VERDICT_KEY[v()!.lastCheck!.verdict]) : t("remote.cloud.bundle.unchecked")}
                          </StatusBadge>
                          <span class="cloud-mono" dir="ltr" data-testid="bundle-hash">{b().hashShort}</span>
                        </div>
                        <details class="cloud-details">
                          <summary>{t("remote.cloud.bundle.details")}</summary>
                          <dl class="cloud-dl">
                            <dt>{t("remote.cloud.bundle.full")}</dt>
                            <dd class="cloud-mono cloud-break" dir="ltr">{b().hashFull}</dd>
                            <dt>{t("remote.cloud.review.key")}</dt>
                            <dd><Fingerprint value={b().pubFingerprint} /></dd>
                            <dt>{t("remote.cloud.bundle.built")}</dt>
                            <dd>{whenText(b().builtAt)}</dd>
                          </dl>
                        </details>
                      </div>
                    )}
                  </Show>
                </FormRow>
                <FormRow label={t("remote.cloud.row.lastDeploy")} description={p().deployedAt ? t("remote.cloud.row.lastDeployLine", { when: whenText(p().deployedAt!), account: p().accountName ?? "-" }) : t("remote.cloud.status.never")}>
                  <div class="cloud-row">
                    <Show when={v()!.updateAvailable}>
                      <span data-testid="update-badge"><Badge tone="accent">{t("remote.cloud.update.available")}</Badge></span>
                    </Show>
                    <Button size="sm" variant="secondary" disabled={readOnly()} onClick={() => setWizard({ startAt: "review" })} data-testid="update">
                      {t("remote.cloud.update.button")}
                    </Button>
                    <ManageMenu view={v()!} disabled={readOnly()} onUpdate={() => setWizard({ startAt: "review" })} />
                  </div>
                </FormRow>
                <Show when={remoteView()?.state !== "off" || frames() > 0}>
                  <FormRow label={t("remote.cloud.row.frames")} description={t("remote.cloud.frames.hint")}>
                    <span data-testid="frames" classList={{ "cloud-warn": framesWarn(frames()) }}>
                      {framesWarn(frames()) ? <TriangleAlert size={12} /> : null} {t("remote.cloud.frames.value", { n: fmt.number(frames()), cap: fmt.number(FREE_DAILY_FRAMES) })}
                    </span>
                  </FormRow>
                </Show>
                <Show when={!inUse()}>
                  <div class="cloud-pad cloud-actions">
                    <Button variant="primary" loading={useCloud.busy()} disabled={readOnly()} onClick={useCloud.start} data-testid="use-cloud">
                      {t("remote.cloud.useNow")}
                    </Button>
                    <span class="cloud-note">{t("remote.cloud.useHint")}</span>
                  </div>
                </Show>
                <div class="cloud-pad">
                  <CostsNotice notice={v()!.limits} />
                </div>
              </>
            )}
          </Show>
        </Show>
        <Show when={code() || useCloud.code()}>
          <div class="cloud-pad">
            <ErrorSummary code={code() ?? useCloud.code()} />
          </div>
        </Show>
      </FormGroup>
      {useCloud.dialog()}
      {useLocal.dialog()}
      <Show when={wizard()}>
        <Suspense>
          <CloudWizard open onClose={() => (setWizard(null), void refreshCloud())} startAt={wizard()!.startAt} onPair={props.onPair} />
        </Suspense>
      </Show>
    </>
  );
}
