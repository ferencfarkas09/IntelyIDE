import { createSignal, lazy, onMount, Show, Suspense } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { AiCapabilities, AiMode, SecretsStatus } from "../../ipc/mongo";
import { Badge, Button, Database, EmptyState, FormGroup, FormRow, SegmentedControl, Skeleton, Switch, toast, TriangleAlert } from "../../ui-kit";
import { setStudioEnabled, studioCompiled, studioEnabled, studioSnapshot } from "./gate";
import { patchPrefs, readPrefs } from "./onboarding/prefs";
import { ResetDialog } from "./onboarding/ResetDialog";
import { messageOf } from "./store";
import "./mongo.css";
import "./manage.css";

const ConnectionManager = lazy(() => import("./ConnectionManager").then((m) => ({ default: m.ConnectionManager })));

/** Settings > Database: the master switch (default off), the Happy preset, the default AI privacy, the profile manager and reset. */
export default function SettingsSection() {
  const [busy, setBusy] = createSignal(false);
  const [privacy, setPrivacy] = createSignal<AiMode>("off");
  const [happy, setHappy] = createSignal(false);
  const [unreadable, setUnreadable] = createSignal<string>();
  const [secrets, setSecrets] = createSignal<SecretsStatus>();
  const [ai, setAi] = createSignal<AiCapabilities>();
  const [resetting, setResetting] = createSignal(false);

  function load() {
    setUnreadable(undefined);
    void readPrefs()
      .then((p) => (setPrivacy(p.defaultAi), setHappy(p.happyPreset)))
      .catch((e) => setUnreadable(messageOf(e)));
    void ipc.mongo.secretsStatus().then(setSecrets).catch(() => undefined);
  }
  onMount(load);
  // The capability probe is a cheap file check, but it is a studio command: only while the switch is on.
  const probeAi = () => void ipc.mongo.aiCapabilities().then(setAi).catch(() => undefined);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await setStudioEnabled(next);
      if (next) probeAi();
    } catch (e) {
      toast.error(t("mongoManage.settings.toggleFailed"), messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  const choose = (p: AiMode) => {
    setPrivacy(p);
    void patchPrefs({ defaultAi: p }).catch((e) => toast.error(t("mongoManage.settings.saveFailed"), messageOf(e)));
  };
  const chooseHappy = (v: boolean) => {
    setHappy(v);
    void patchPrefs({ happyPreset: v }).catch((e) => (setHappy(!v), toast.error(t("mongoManage.settings.saveFailed"), messageOf(e))));
  };
  const storeText = () => {
    const s = secrets();
    return !s ? "" : s.store === "keychain" ? t("mongoManage.settings.store.keychain") : s.store === "session" ? t("mongoManage.settings.store.session") : t("mongoManage.settings.store.unavailable");
  };

  return (
    <div class="mg-settings">
      <Show when={unreadable()}>
        <EmptyState tone="danger" icon={Database} title={t("mongoManage.settings.unreadable")} description={unreadable()} action={<Button size="sm" onClick={load}>{t("mongoManage.retry")}</Button>} />
      </Show>
      <FormGroup title={t("mongoManage.settings.title")} description={t("mongoManage.settings.desc")}>
        <FormRow
          label={t("mongoManage.settings.enable")}
          description={studioCompiled() === false ? t("mongoManage.settings.notCompiled") : t("mongoManage.settings.enableDesc")}
        >
          <Switch checked={studioEnabled()} disabled={busy() || studioCompiled() === false} onChange={(v) => void toggle(v)} aria-label={t("mongoManage.settings.enable")} label={studioEnabled() ? t("mongoManage.on") : t("mongoManage.off")} />
        </FormRow>
        <Show when={secrets()}>
          <FormRow label={t("mongoManage.settings.secrets")} description={storeText()}>
            <Badge size="sm" tone={secrets()!.store === "keychain" ? "ok" : "warn"}>{t(`mongoManage.settings.storeBadge.${secrets()!.store}`)}</Badge>
          </FormRow>
        </Show>
      </FormGroup>
      <Show when={studioSnapshot()?.network === "refused"}>
        <p class="mm-banner" data-tone="warn" role="status"><TriangleAlert size={14} aria-hidden="true" /> <span>{t("mongoManage.network.refused")}</span></p>
      </Show>
      <Show when={studioEnabled()}>
        <FormGroup title={t("mongoManage.settings.aiTitle")} description={t("mongoManage.settings.aiDesc")}>
          <FormRow label={t("mongoManage.settings.privacy")} description={privacy() === "off" ? t("mongoManage.settings.p0") : privacy() === "schemaOnly" ? t("mongoManage.settings.p1") : t("mongoManage.settings.p1plus")}>
            <SegmentedControl aria-label={t("mongoManage.settings.privacyAria")} size="sm" value={privacy()} onChange={choose} options={[{ value: "off", label: t("mongoManage.settings.opt.p0") }, { value: "schemaOnly", label: t("mongoManage.settings.opt.p1") }, { value: "schemaEnums", label: t("mongoManage.settings.opt.p1plus") }]} />
          </FormRow>
          <FormRow label={t("mongoManage.settings.cli")} description={t("mongoManage.settings.cliDesc")}>
            <Show when={ai()} fallback={<Button size="sm" variant="secondary" onClick={probeAi}>{t("mongoManage.settings.cliCheck")}</Button>}>
              {(c) => <Badge size="sm" tone={c().node && c().claudeCli && c().script ? "ok" : "warn"}>{c().node && c().claudeCli && c().script ? t("mongoManage.settings.cliFound") : c().node ? t("mongoManage.settings.cliNoCli") : t("mongoManage.settings.cliNoNode")}</Badge>}
            </Show>
          </FormRow>
          <FormRow label={t("mongoManage.settings.happy")} description={t("mongoManage.settings.happyDesc")}>
            <Switch checked={happy()} onChange={chooseHappy} aria-label={t("mongoManage.settings.happy")} label={happy() ? t("mongoManage.on") : t("mongoManage.off")} />
          </FormRow>
          <FormRow label={t("mongoManage.settings.later")} description={t("mongoManage.settings.laterDesc")}>
            <Badge size="sm">{t("mongoManage.settings.laterBadge")}</Badge>
          </FormRow>
        </FormGroup>
        <section class="mg-settings__profiles" aria-label={t("mongoManage.settings.profiles")}>
          <h4 class="mg-settings__h">{t("mongoManage.settings.connections")}</h4>
          <Suspense fallback={<Skeleton height={96} />}>
            <ConnectionManager compact defaultAi={privacy()} />
          </Suspense>
        </section>
      </Show>
      <FormGroup title={t("mongoManage.settings.dangerTitle")} description={t("mongoManage.settings.dangerDesc")}>
        <FormRow label={t("mongoManage.settings.reset")} description={t("mongoManage.settings.resetDesc")}>
          <Button size="sm" variant="danger" onClick={() => setResetting(true)}>{t("mongoManage.settings.resetButton")}</Button>
        </FormRow>
      </FormGroup>
      <Show when={resetting()}>
        <ResetDialog onClose={() => setResetting(false)} />
      </Show>
    </div>
  );
}
