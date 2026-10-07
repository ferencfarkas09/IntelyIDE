import { createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Capability, DeviceView } from "../../ipc/remote";
import { Badge, Button, CircleAlert, FormGroup, FormRow, Input, Lock, Plus, ShieldAlert, Smartphone, StatusDot, Switch, Trash2, Unplug } from "../../ui-kit";
import { SegmentedControl } from "../../ui-kit";
import { kill, panic } from "./actions";
import { PairDialog } from "./PairDialog";
import RelayGroup from "./cloud/RelayGroup";
import { ago, auditLabel, CAPABILITY_LABEL, deviceLine, STATE_LABEL } from "./logic";
import { applyRemote, isOn, refreshRemote, remoteView } from "./state";
import "./remote.css";

const message = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

export default function RemoteSection() {
  const [problem, setProblem] = createSignal<string | null>(null);
  const [pairing, setPairing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [macName, setMacName] = createSignal("");
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const [showAudit, setShowAudit] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    void refreshRemote()
      .then((v) => setMacName(v.macName))
      .catch((e) => setProblem(message(e)));
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  });

  const v = remoteView;
  const run = async (op: () => Promise<unknown>) => {
    setProblem(null);
    setBusy(true);
    try {
      await op();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (on: boolean) =>
    run(async () => {
      await applyRemote(on ? ipc.remote.enable : ipc.remote.disable);
    });
  const saveConfig = () =>
    run(async () => {
      await ipc.remote.configure({ macName: macName().trim() || undefined });
      await refreshRemote();
    });
  const setLevel = (d: DeviceView, c: Capability) => run(async () => (await ipc.remote.setCapability(d.id, c), await refreshRemote()));
  const revoke = (d: DeviceView) =>
    run(async () => {
      await ipc.remote.revoke(d.id);
      setConfirm(null);
      await refreshRemote();
    });

  return (
    <div class="remote">
      <FormGroup title={t("remote.title")} description={t("remote.titleDesc")}>
        <FormRow label={t("remote.enable")} description={v() ? STATE_LABEL[v()!.state] : t("remote.state.off")}>
          <div class="remote__switch">
            <Show when={v()?.state === "online"}>
              <StatusDot tone="ok" />
            </Show>
            <Switch checked={isOn()} disabled={busy() || v()?.state === "tampered"} onChange={(on) => void toggle(on)} aria-label={t("remote.enable")} />
          </div>
        </FormRow>
        <Show when={v()?.tampered}>
          <div class="remote__alert" role="alert">
            <CircleAlert size={14} /> {v()!.tampered}
          </div>
        </Show>
        <FormRow label={t("remote.macName")} labelFor="remote-mac-name">
          <Input id="remote-mac-name" size="sm" value={macName() || v()?.macName || ""} maxLength={60} onInput={(e) => setMacName(e.currentTarget.value)} onChange={() => void saveConfig()} />
        </FormRow>
        <FormRow label={t("remote.e2e")} description={t("remote.e2eNote")} stacked>
          <Show when={v()?.expectedBundleHash} fallback={<Badge tone="warn" icon={CircleAlert}>{t("remote.noHash")}</Badge>}>
            <p class="remote-hash">{v()!.expectedBundleHash}</p>
          </Show>
        </FormRow>
        <FormRow label={t("remote.claudeRc")} description={t("remote.claudeRcDesc")}>
          <Badge tone="ok" icon={Lock}>
            {v()?.claudeRemoteControl === "blocked" ? t("remote.blocked") : (v()?.claudeRemoteControl ?? t("remote.blocked"))}
          </Badge>
        </FormRow>
      </FormGroup>

      <RelayGroup onPair={() => setPairing(true)} />

      <FormGroup title={t("remote.phones")} description={t("remote.phonesDesc")}>
        <Show when={v()?.devices.length} fallback={<p class="remote-note remote__empty">{t("remote.noPhones")}</p>}>
          <For each={v()!.devices}>
            {(d) => (
              <div class="remote-device" data-testid="device-row">
                <Smartphone size={16} />
                <div class="remote-device__text">
                  <span class="remote-device__name">
                    {d.name}
                    <Badge tone={d.capability === "reply" ? "accent" : "neutral"} size="sm">
                      {CAPABILITY_LABEL[d.capability]}
                    </Badge>
                  </span>
                  <span class="remote-note">{deviceLine(d, now())}</span>
                </div>
                <SegmentedControl
                  aria-label={t("remote.levelOf", { name: d.name })}
                  size="sm"
                  options={[
                    { value: "view" as Capability, label: t("remote.level.view") },
                    { value: "reply" as Capability, label: t("remote.level.reply") },
                  ]}
                  value={d.capability}
                  onChange={(c) => void setLevel(d, c)}
                />
                <Show
                  when={confirm() === d.id}
                  fallback={
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(d.id)} aria-label={t("remote.revokeName", { name: d.name })}>
                      {t("remote.revoke")}
                    </Button>
                  }
                >
                  <Button size="sm" variant="danger" onClick={() => void revoke(d)}>
                    {t("remote.revokeNow")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    {t("remote.keep")}
                  </Button>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <div class="remote__row remote__pad">
          <Button variant="primary" icon={Plus} disabled={!isOn() || busy()} onClick={() => setPairing(true)} data-testid="pair">
            {t("remote.pair")}
          </Button>
          <Show when={!isOn()}>
            <span class="remote-note">{t("remote.switchOnFirst")}</span>
          </Show>
        </div>
      </FormGroup>

      <FormGroup title={t("remote.emergency")} description={t("remote.emergencyDesc")}>
        <div class="remote__row remote__pad">
          <Button variant="secondary" icon={Unplug} disabled={!isOn()} onClick={() => void kill()} data-testid="kill">
            {t("remote.killBtn")}
          </Button>
          <Button variant="danger" icon={ShieldAlert} onClick={() => void panic()} data-testid="panic">
            {t("remote.panicBtn")}
          </Button>
        </div>
      </FormGroup>

      <FormGroup title={t("remote.audit")} description={t("remote.auditDesc")}>
        <Show when={v()?.audit.length} fallback={<p class="remote-note remote__empty">{t("remote.auditEmpty")}</p>}>
          <div class="remote__pad">
            <Button size="sm" variant="ghost" onClick={() => setShowAudit(!showAudit())} data-testid="audit-toggle">
              {showAudit() ? t("remote.auditHide", { shown: v()!.audit.length, total: v()!.auditLen }) : t("remote.auditShow", { shown: v()!.audit.length, total: v()!.auditLen })}
            </Button>
          </div>
          <Show when={showAudit()}>
            <ul class="remote-audit" data-testid="audit">
              <For each={[...v()!.audit].reverse()}>
                {(a) => (
                  <li>
                    <span class="remote-audit__when">{ago(a.ts, now())}</span>
                    <span>{auditLabel(a.event)}</span>
                    <Show when={a.detail}>
                      <span class="remote-note">{a.detail}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </FormGroup>

      <Show when={problem()}>
        <p class="remote-problem" role="alert">
          {problem()}
        </p>
      </Show>
      <PairDialog open={pairing()} onClose={() => setPairing(false)} />
    </div>
  );
}
