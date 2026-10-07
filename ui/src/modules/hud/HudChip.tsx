import { createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { HudSnapshot, ProcRow } from "../../ipc/hud";
import { ecoActive, ecoInterval } from "../../platform/eco";
import { Button, Cpu, IconButton, Leaf, MemoryStick, Popover, RefreshCw, Trash2, toast } from "../../ui-kit";
import { byKind, formatMb, KIND_LABEL, pressure } from "./logic";
import { hudSettings } from "./state";
import "./hud.css";

const POLL_CLOSED_MS = 15_000;
const POLL_OPEN_MS = 3_000;

/** Status-bar chip: the app tree's resident memory. Polls a cheap `ps` every 15 s (3 s while open); nothing while Eco is on. */
export default function HudChip() {
  const [snap, setSnap] = createSignal<HudSnapshot>();
  const [open, setOpen] = createSignal(false);
  const refresh = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void ipc.hud.snapshot().then(setSnap, () => undefined);
  };
  refresh();
  let stop = ecoInterval(refresh, POLL_CLOSED_MS);
  const rearm = (ms: number) => {
    stop();
    stop = ecoInterval(refresh, ms);
  };
  onCleanup(() => stop());
  const total = () => snap()?.totalBytes ?? 0;

  return (
    <Popover
      open={open()}
      onOpenChange={(o) => {
        setOpen(o);
        rearm(o ? POLL_OPEN_MS : POLL_CLOSED_MS);
        if (o) refresh();
      }}
      placement="top-end"
      aria-label={t("hud.usage")}
      class="hud-popover"
      trigger={(p) => (
        <button {...p} type="button" class="sb__item sb__attention hud-chip" data-pressure={pressure(total())} data-eco={ecoActive() ? "" : undefined} aria-label={ecoActive() ? t("hud.chipAriaEco", { mem: formatMb(total()) }) : t("hud.chipAria", { mem: formatMb(total()) })}>
          <Show when={ecoActive()} fallback={<MemoryStick size={12} aria-hidden="true" />}>
            <Leaf size={12} aria-hidden="true" />
          </Show>
          <span class="ui-tnum">{snap() ? formatMb(total()) : "..."}</span>
        </button>
      )}
    >
      {(api) => <HudPopover snap={snap()} refresh={refresh} close={api.close} />}
    </Popover>
  );
}

function HudPopover(props: { snap: HudSnapshot | undefined; refresh: () => void; close: () => void }) {
  const [busy, setBusy] = createSignal<number>();
  const max = () => Math.max(1, ...(props.snap?.rows.map((r) => r.rssBytes) ?? [1]));
  async function kill(r: ProcRow) {
    setBusy(r.pid);
    try {
      await ipc.hud.kill(r.pid);
      toast.success(t("hud.stopped", { name: r.name }));
    } catch (e) {
      toast.error((e as { message?: string }).message ?? t("hud.stopFailed"));
    } finally {
      setBusy(undefined);
      props.refresh();
    }
  }
  async function restart() {
    try {
      const had = await ipc.hud.restartSidecar();
      toast.info(had ? t("hud.sidecarStopped") : t("hud.noSidecar"));
    } catch (e) {
      toast.error((e as { message?: string }).message ?? t("hud.restartFailed"));
    }
    props.refresh();
  }
  return (
    <div class="hud-pop">
      <header class="hud-pop__head">
        <Cpu size={14} aria-hidden="true" />
        <strong>{t("hud.resources")}</strong>
        <span class="hud-pop__total ui-tnum">{formatMb(props.snap?.totalBytes ?? 0)}</span>
        <IconButton icon={RefreshCw} label={t("hud.refresh")} size="sm" onClick={props.refresh} />
      </header>
      <div class="hud-pop__sum">
        <For each={byKind(props.snap?.rows ?? [])}>
          {(k) => (
            <span class="hud-pop__kind" data-kind={k.kind}>
              {KIND_LABEL[k.kind]} <b class="ui-tnum">{formatMb(k.bytes)}</b>
            </span>
          )}
        </For>
      </div>
      <ul class="hud-pop__rows" aria-label={t("hud.processes")}>
        <For each={props.snap?.rows ?? []}>
          {(r) => (
            <li class="hud-row" data-kind={r.kind}>
              <span class="hud-row__name ui-truncate" title={t("hud.procTitle", { name: r.name, pid: r.pid })}>
                {r.name}
              </span>
              <span class="hud-row__kind">{KIND_LABEL[r.kind]}</span>
              <span class="hud-row__bar" aria-hidden="true">
                <i style={{ width: `${Math.max(2, (r.rssBytes / max()) * 100)}%` }} />
              </span>
              <span class="hud-row__mb ui-tnum">{formatMb(r.rssBytes)}</span>
              <IconButton icon={Trash2} label={r.canKill ? t("hud.stopName", { name: r.name }) : t("hud.cannotStopApp")} size="sm" disabled={!r.canKill || busy() === r.pid} onClick={() => void kill(r)} />
            </li>
          )}
        </For>
      </ul>
      <footer class="hud-pop__foot">
        <Show when={ecoActive()}>
          <span class="hud-pop__eco">
            <Leaf size={12} aria-hidden="true" /> {t("hud.ecoOn")}
          </span>
        </Show>
        <Show when={!ecoActive() && hudSettings().eco}>
          <span class="hud-pop__eco" data-armed="">
            <Leaf size={12} aria-hidden="true" /> {t("hud.ecoAfter", { n: hudSettings().ecoMinutes })}
          </span>
        </Show>
        <span style={{ flex: "1" }} />
        <Button size="sm" variant="secondary" disabled={!props.snap?.sidecarPid} onClick={() => void restart()}>
          {t("hud.restartSidecar")}
        </Button>
      </footer>
    </div>
  );
}
