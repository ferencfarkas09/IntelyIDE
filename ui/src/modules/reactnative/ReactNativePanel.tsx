import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { openSettings } from "../../platform/settings";
import { formatRss } from "../../store/devservers";
import { repoConfig, repos } from "../../store/workspace";
import { Badge, Button, Copy, Dialog, EmptyState, ExternalLink, Icon, IconButton, Play, RefreshCw, RotateCw, Select, SegmentedControl, Smartphone, Square, StatusDot, Trash2, TriangleAlert } from "../../ui-kit";
import { fixWithAgent } from "./agent";
import { anyDetected, detectedRepoIds, selectedProject, selectedRepoId, selectRepo } from "./detection";
import {
  bootDevice, busyAction, cancelPending, clearLog, confirmPending, copyLog, countOf, deviceList, deviceListError, deviceListing, deviceLog, dismissCard, errorCards, loadMetroLog, metroLive, metroLog, metroServer,
  pendingStart, processAccess, refreshAccess, refreshAll, refreshDevices, reloadApp, restartMetro, setLogFilter, shutdownDevice, startLog, startMetro, startScript, stopLog, stopMetro, visibleLines,
  type LogFilter,
} from "./store";
import type { AdbState, ErrorCard, Platform, PodsState, ProjectInfo, ToolStatus } from "./types";
import "./reactnative.css";

const POD_KEY: Record<PodsState, Parameters<typeof t>[0]> = {
  notApplicable: "reactnative.pods.notApplicable",
  missing: "reactnative.pods.missing",
  stale: "reactnative.pods.stale",
  installed: "reactnative.pods.installed",
};
const ADB_KEY: Record<AdbState, Parameters<typeof t>[0]> = {
  device: "reactnative.adb.device",
  offline: "reactnative.adb.offline",
  unauthorized: "reactnative.adb.unauthorized",
  noPermissions: "reactnative.adb.noPermissions",
  other: "reactnative.adb.other",
};
const HINT_KEY = {
  xcode: "reactnative.hint.xcode",
  macOnly: "reactnative.hint.macOnly",
  androidPlatformTools: "reactnative.hint.androidPlatformTools",
  androidEmulator: "reactnative.hint.androidEmulator",
} as const;
const ERROR_TITLE = {
  redbox: "reactnative.err.redbox.title",
  unresolvedModule: "reactnative.err.unresolvedModule.title",
  undefinedFunction: "reactnative.err.undefinedFunction.title",
  nativeCrash: "reactnative.err.nativeCrash.title",
  gradleFailed: "reactnative.err.gradleFailed.title",
  xcodeFailed: "reactnative.err.xcodeFailed.title",
  noBundleUrl: "reactnative.err.noBundleUrl.title",
  portInUse: "reactnative.err.portInUse.title",
  podsOutOfDate: "reactnative.err.podsOutOfDate.title",
  jsException: "reactnative.err.jsException.title",
} as const;
const ERROR_WHY = {
  redbox: "reactnative.err.redbox.why",
  unresolvedModule: "reactnative.err.unresolvedModule.why",
  undefinedFunction: "reactnative.err.undefinedFunction.why",
  nativeCrash: "reactnative.err.nativeCrash.why",
  gradleFailed: "reactnative.err.gradleFailed.why",
  xcodeFailed: "reactnative.err.xcodeFailed.why",
  noBundleUrl: "reactnative.err.noBundleUrl.why",
  portInUse: "reactnative.err.portInUse.why",
  podsOutOfDate: "reactnative.err.podsOutOfDate.why",
  jsException: "reactnative.err.jsException.why",
} as const;
const SOURCE_KEY = { metro: "reactnative.source.metro", ios: "reactnative.source.ios", android: "reactnative.source.android" } as const;

const onOff = (v: boolean | null): string => (v === null ? t("reactnative.unknown") : v ? t("reactnative.on") : t("reactnative.off"));

function Fact(props: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div class="rn-fact">
      <dt>{props.label}</dt>
      <dd data-tone={props.tone}>{props.value}</dd>
    </div>
  );
}

function StatusCard(props: { project: ProjectInfo }) {
  const p = () => props.project;
  return (
    <section class="rn-card" aria-label={t("reactnative.status.aria")}>
      <div class="rn-card__head">
        <Icon icon={Smartphone} size={16} />
        <h3 class="rn-h">{p().name}</h3>
        <Badge tone="accent">{p().kind === "expo" ? t("reactnative.kind.expo") : t("reactnative.kind.reactNative")}</Badge>
      </div>
      <dl class="rn-facts">
        <Fact label={t("reactnative.fact.rn")} value={p().rnVersion ?? t("reactnative.unknown")} />
        <Show when={p().expoVersion}>{(v) => <Fact label={t("reactnative.fact.expo")} value={v()} />}</Show>
        <Fact label={t("reactnative.fact.newArch")} value={onOff(p().newArch)} />
        <Fact label={t("reactnative.fact.hermes")} value={onOff(p().hermes)} />
        <Fact label={t("reactnative.fact.pm")} value={p().packageManager} />
        <Fact label={t("reactnative.fact.pods")} value={t(POD_KEY[p().pods])} tone={p().pods === "installed" ? "ok" : p().pods === "notApplicable" ? undefined : "warn"} />
        <Fact label={t("reactnative.fact.androidSdk")} value={p().androidSdk ?? t("reactnative.sdk.missing")} tone={p().androidSdk ? "ok" : "warn"} />
      </dl>
      <Show when={p().pods === "missing" || p().pods === "stale"}>
        <p class="rn-note"><Icon icon={TriangleAlert} size={14} /> {t("reactnative.pods.hint", { pm: p().packageManager })}</p>
      </Show>
    </section>
  );
}

function AccessNote() {
  return (
    <Show when={processAccess() && !processAccess()!.startable}>
      <p class="rn-note" role="status">
        <Icon icon={TriangleAlert} size={14} /> {t("reactnative.blocked")}{" "}
        <Button size="sm" variant="ghost" onClick={() => openSettings("safety")}>{t("reactnative.openSettings")}</Button>
      </p>
    </Show>
  );
}

function MetroCard(props: { project: ProjectInfo }) {
  const server = metroServer;
  const blocked = () => !!processAccess() && !processAccess()!.startable;
  const lines = () => metroLog().slice(-200);
  let box: HTMLPreElement | undefined;
  createEffect(on(() => metroLog().length, () => queueMicrotask(() => box && (box.scrollTop = box.scrollHeight))));
  createEffect(on(() => server()?.id, (id) => id && void loadMetroLog(id)));
  const port = () => server()?.ports[0];
  return (
    <section class="rn-card" aria-label={t("reactnative.metro.aria")}>
      <div class="rn-card__head">
        <h3 class="rn-h">{props.project.kind === "expo" ? t("reactnative.metro.titleExpo") : t("reactnative.metro.title")}</h3>
        <Show when={server()}>{(s) => <StatusDot tone={metroLive() ? "ok" : "neutral"} label={t(`reactnative.metro.status.${s().status}`)} />}</Show>
        <Show when={port()}>{(pt) => <Badge tone="info" numeric>{`:${pt()}`}</Badge>}</Show>
        <Show when={server()?.rssMb != null}><span class="rn-meta">{formatRss(server()?.rssMb)}</span></Show>
        <span class="rn-spacer" />
        <Show
          when={metroLive()}
          fallback={<Button size="sm" icon={Play} disabled={blocked() || !props.project.metroScript} onClick={() => void startMetro()}>{t("reactnative.metro.start")}</Button>}
        >
          <Button size="sm" variant="secondary" icon={Square} onClick={stopMetro}>{t("reactnative.metro.stop")}</Button>
          <Button size="sm" variant="secondary" icon={RotateCw} onClick={restartMetro}>{t("reactnative.metro.restart")}</Button>
          <Button size="sm" variant="secondary" disabled={!port()} onClick={() => void reloadApp()}>{t("reactnative.metro.reload")}</Button>
        </Show>
      </div>
      <Show when={!props.project.metroScript}>
        <p class="rn-note"><Icon icon={TriangleAlert} size={14} /> {t("reactnative.metro.noScript")}</p>
      </Show>
      <AccessNote />
      <Show when={lines().length > 0}>
        <pre class="rn-log ui-selectable" ref={box} aria-label={t("reactnative.metro.logAria")}>{lines().join("\n")}</pre>
      </Show>
    </section>
  );
}

function ToolNote(props: { tool: ToolStatus }) {
  return (
    <p class="rn-note" data-tool={props.tool.name}>
      <Icon icon={TriangleAlert} size={14} />
      <span><strong>{props.tool.name}</strong>: {t("reactnative.tool.missing")} {props.tool.hint && props.tool.hint in HINT_KEY ? t(HINT_KEY[props.tool.hint as keyof typeof HINT_KEY]) : ""}</span>
    </p>
  );
}

function DevicesCard(props: { project: ProjectInfo }) {
  const list = deviceList;
  const noAccess = () => !!processAccess() && !processAccess()!.startable;
  const tool = (name: string) => list()?.tools.find((x) => x.name === name);
  return (
    <section class="rn-card" aria-label={t("reactnative.devices.aria")}>
      <div class="rn-card__head">
        <h3 class="rn-h">{t("reactnative.devices.title")}</h3>
        <span class="rn-spacer" />
        <IconButton icon={RefreshCw} label={t("reactnative.devices.refresh")} size="sm" disabled={deviceListing()} onClick={() => void refreshDevices()} />
      </div>
      <Show when={deviceListError()}>{(e) => <p class="rn-error" role="alert">{e()}</p>}</Show>
      <Show when={noAccess()}><AccessNote /></Show>
      <Show when={list()} fallback={<Show when={!deviceListError() && !noAccess()}><p class="rn-meta">{t("reactnative.devices.loading")}</p></Show>}>
        {(l) => (
          <>
            <For each={l().tools.filter((x) => !x.available)}>{(x) => <ToolNote tool={x} />}</For>
            <Show when={tool("xcrun")?.available}>
              <h4 class="rn-sub">{t("reactnative.devices.ios")}</h4>
              <Show when={l().ios.length > 0} fallback={<p class="rn-meta">{t("reactnative.devices.noIos")}</p>}>
                <ul class="rn-list">
                  <For each={l().ios}>
                    {(d) => (
                      <li class="rn-row" data-state={d.state}>
                        <StatusDot tone={d.state === "booted" ? "ok" : "neutral"} label={t(`reactnative.sim.${d.state}`)} />
                        <span class="rn-row__name ui-truncate">{d.name}</span>
                        <span class="rn-meta">{d.runtime}</span>
                        <span class="rn-spacer" />
                        <Show
                          when={d.state === "booted"}
                          fallback={<Button size="sm" variant="secondary" disabled={d.state === "busy" || busyAction() === `boot:${d.udid}`} loading={busyAction() === `boot:${d.udid}`} onClick={() => void bootDevice("ios", d.udid)}>{t("reactnative.device.boot")}</Button>}
                        >
                          <Button size="sm" variant="secondary" disabled={!props.project.iosScript} onClick={() => void startScript(props.project.iosScript)}>{t("reactnative.device.openApp")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => void startLog("ios", d.udid)}>{t("reactnative.device.logs")}</Button>
                          <Button size="sm" variant="ghost" loading={busyAction() === `down:${d.udid}`} onClick={() => void shutdownDevice("ios", d.udid)}>{t("reactnative.device.shutdown")}</Button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={!props.project.iosScript}><p class="rn-meta">{t("reactnative.device.noIosScript")}</p></Show>
              </Show>
            </Show>
            <Show when={tool("adb")?.available || tool("emulator")?.available}>
              <h4 class="rn-sub">{t("reactnative.devices.android")}</h4>
              <ul class="rn-list">
                <For each={l().android}>
                  {(d) => (
                    <li class="rn-row" data-state={d.state}>
                      <StatusDot tone={d.state === "device" ? "ok" : "warn"} label={t(ADB_KEY[d.state])} />
                      <span class="rn-row__name ui-truncate">{d.model ?? d.serial}</span>
                      <span class="rn-meta">{d.isEmulator ? t("reactnative.android.emulator") : t("reactnative.android.phone")} · {d.serial}</span>
                      <span class="rn-spacer" />
                      <Show when={d.state === "device"} fallback={<span class="rn-meta">{t(ADB_KEY[d.state])}</span>}>
                        <Button size="sm" variant="secondary" disabled={!props.project.androidScript} onClick={() => void startScript(props.project.androidScript)}>{t("reactnative.device.openApp")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => void startLog("android", d.serial)}>{t("reactnative.device.logs")}</Button>
                        <Show when={d.isEmulator}><Button size="sm" variant="ghost" loading={busyAction() === `down:${d.serial}`} onClick={() => void shutdownDevice("android", d.serial)}>{t("reactnative.device.shutdown")}</Button></Show>
                      </Show>
                    </li>
                  )}
                </For>
                <For each={l().avds.filter(() => tool("emulator")?.available)}>
                  {(name) => (
                    <li class="rn-row">
                      <StatusDot tone="neutral" label={t("reactnative.sim.shutdown")} />
                      <span class="rn-row__name ui-truncate">{name}</span>
                      <span class="rn-meta">{t("reactnative.android.avd")}</span>
                      <span class="rn-spacer" />
                      <Button size="sm" variant="secondary" loading={busyAction() === `boot:${name}`} onClick={() => void bootDevice("android", name)}>{t("reactnative.device.boot")}</Button>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={l().android.length === 0 && l().avds.length === 0}><p class="rn-meta">{t("reactnative.devices.noAndroid")}</p></Show>
              <Show when={!props.project.androidScript}><p class="rn-meta">{t("reactnative.device.noAndroidScript")}</p></Show>
            </Show>
            <For each={l().notes}>{(n) => <p class="rn-meta">{t("reactnative.devices.note", { note: n })}</p>}</For>
          </>
        )}
      </Show>
    </section>
  );
}

function LogsCard() {
  const [platform, setPlatform] = createSignal<Platform>("ios");
  const state = () => deviceLog(platform());
  const lines = () => visibleLines(state()).slice(-500);
  let box: HTMLDivElement | undefined;
  createEffect(on(() => state().lines.length, () => queueMicrotask(() => box && (box.scrollTop = box.scrollHeight))));
  const chips = (): { id: LogFilter; label: string }[] => [
    { id: "all", label: t("reactnative.logs.all") },
    { id: "warn", label: t("reactnative.logs.warnings", { n: countOf(state(), "warn") }) },
    { id: "error", label: t("reactnative.logs.errors", { n: countOf(state(), "error") }) },
  ];
  return (
    <section class="rn-card" aria-label={t("reactnative.logs.aria")}>
      <div class="rn-card__head">
        <h3 class="rn-h">{t("reactnative.logs.title")}</h3>
        <SegmentedControl size="sm" aria-label={t("reactnative.logs.platform")} value={platform()} onChange={setPlatform} options={[{ value: "ios", label: "iOS" }, { value: "android", label: "Android" }]} />
        <span class="rn-spacer" />
        <Show when={state().running} fallback={<Button size="sm" icon={Play} onClick={() => void startLog(platform())}>{t("reactnative.logs.start")}</Button>}>
          <Button size="sm" variant="secondary" icon={Square} onClick={() => void stopLog(platform())}>{t("reactnative.logs.stop")}</Button>
        </Show>
        <IconButton icon={Copy} label={t("reactnative.logs.copy")} size="sm" disabled={lines().length === 0} onClick={() => void copyLog(platform())} />
        <IconButton icon={Trash2} label={t("reactnative.logs.clear")} size="sm" disabled={state().lines.length === 0} onClick={() => void clearLog(platform())} />
      </div>
      <div class="rn-chips" role="group" aria-label={t("reactnative.logs.filter")}>
        <For each={chips()}>
          {(c) => <button type="button" class="rn-chip" aria-pressed={state().filter === c.id} onClick={() => setLogFilter(platform(), c.id)}>{c.label}</button>}
        </For>
        <Show when={state().dropped > 0}><span class="rn-meta">{t("reactnative.logs.dropped", { n: state().dropped })}</span></Show>
      </div>
      <Show when={!state().running && state().exitCode !== null && state().exitCode !== 0}>
        <p class="rn-note"><Icon icon={TriangleAlert} size={14} /> {t("reactnative.logs.ended", { code: state().exitCode ?? 0 })}</p>
      </Show>
      <div class="rn-log rn-log--lines ui-selectable" ref={box} role="log" aria-label={t("reactnative.logs.aria")}>
        <Show when={lines().length > 0} fallback={<span class="rn-meta">{state().running ? t("reactnative.logs.waiting") : t("reactnative.logs.idle")}</span>}>
          <For each={lines()}>{(l) => <div class="rn-line" data-level={l.level}>{l.text}</div>}</For>
        </Show>
      </div>
    </section>
  );
}

function ErrorsCard(props: { project: ProjectInfo }) {
  const [failed, setFailed] = createSignal<string | undefined>();
  const fix = async (c: ErrorCard) => {
    const ok = await fixWithAgent(c, props.project, selectedRepoId()!);
    setFailed(ok ? undefined : c.id);
  };
  return (
    <Show when={errorCards().length > 0}>
      <section class="rn-card" aria-label={t("reactnative.errors.aria")}>
        <div class="rn-card__head">
          <h3 class="rn-h">{t("reactnative.errors.title")}</h3>
          <Badge tone="danger" numeric>{errorCards().length}</Badge>
        </div>
        <For each={errorCards()}>
          {(c) => (
            <article class="rn-error-card" data-kind={c.kind}>
              <header>
                <Icon icon={TriangleAlert} size={14} />
                <strong>{t(ERROR_TITLE[c.kind])}</strong>
                <span class="rn-meta">{t(SOURCE_KEY[c.source])}</span>
                <Show when={c.count > 1}><Badge numeric>{`×${c.count}`}</Badge></Show>
              </header>
              <p>{t(ERROR_WHY[c.kind])}</p>
              <code class="rn-snippet ui-selectable">{c.snippet}</code>
              <footer>
                <Button size="sm" icon={ExternalLink} onClick={() => void fix(c)}>{t("reactnative.errors.fix")}</Button>
                <Button size="sm" variant="ghost" onClick={() => dismissCard(c)}>{t("reactnative.errors.dismiss")}</Button>
                <Show when={failed() === c.id}><span class="rn-error">{t("reactnative.errors.noDialog")}</span></Show>
              </footer>
            </article>
          )}
        </For>
      </section>
    </Show>
  );
}

function ConfirmDialog() {
  const p = pendingStart;
  return (
    <Dialog
      open={!!p()}
      onClose={cancelPending}
      size="sm"
      role="alertdialog"
      title={t("reactnative.confirm.title", { runner: p()?.script.runner ?? "" })}
      description={t("reactnative.confirm.desc")}
      footer={
        <>
          <Button variant="ghost" onClick={cancelPending}>{t("reactnative.confirm.cancel")}</Button>
          <Button variant="danger" data-autofocus onClick={confirmPending}>{t("reactnative.confirm.run")}</Button>
        </>
      }
    >
      <ul class="rn-reasons">
        <For each={p()?.script.reasons ?? []}>{(r) => <li>{r}</li>}</For>
      </ul>
    </Dialog>
  );
}

/** The React Native panel: the project's status, Metro, devices, device logs and the errors found in them. */
export default function ReactNativePanel() {
  onMount(() => {
    void refreshAccess().then(refreshDevices);
    const id = metroServer()?.id;
    if (id) void loadMetroLog(id);
  });
  createEffect(on(selectedRepoId, (id, prev) => id && prev !== undefined && (void refreshAccess().then(refreshDevices)), { defer: true }));
  return (
    <div class="rn">
      <div class="rn__bar">
        <Icon icon={Smartphone} size={16} />
        <h2 class="rn__title">{t("reactnative.title")}</h2>
        <Show when={detectedRepoIds().length > 1}>
          <Select size="sm" aria-label={t("reactnative.repo")} value={selectedRepoId()} onChange={selectRepo} options={detectedRepoIds().map((id) => ({ value: id, label: repoConfig(id)?.name ?? id }))} />
        </Show>
        <span class="rn-spacer" />
        <IconButton icon={RefreshCw} label={t("reactnative.refresh")} size="sm" onClick={() => void refreshAll(repos().map((r) => r.id))} />
      </div>
      <Show when={anyDetected() && selectedProject()} fallback={<EmptyState icon={Smartphone} title={t("reactnative.none")} />}>
        {(_) => (
          <>
            <StatusCard project={selectedProject()!} />
            <MetroCard project={selectedProject()!} />
            <DevicesCard project={selectedProject()!} />
            <LogsCard />
            <ErrorsCard project={selectedProject()!} />
          </>
        )}
      </Show>
      <ConfirmDialog />
    </div>
  );
}
