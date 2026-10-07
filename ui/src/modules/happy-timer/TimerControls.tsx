import { createSignal, Show } from "solid-js";
import { tRich } from "../../components/richText";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { Trackable } from "../../ipc/happy";
import { timerView } from "../../store/happy";
import { Button, Pause, Play, Square, StatusDot, type Tone } from "../../ui-kit";
import { attempt } from "./actions";
import { elapsedSec, formatClock, isTarget } from "./logic";
import { Picker } from "./Picker";
import "./timer.css";

const PHASE: Record<string, { label: MessageKey; tone: Tone }> = {
  idle: { label: "htm.phase.idle", tone: "neutral" },
  running: { label: "htm.phase.running", tone: "ok" },
  paused: { label: "htm.phase.paused", tone: "warn" },
  break: { label: "htm.phase.break", tone: "info" },
};

/** Clock, Stop/Pause/Resume and the task picker: shared by the status-bar popover and the Time dock tab. */
export function TimerControls(props: { now: () => number; onChanged?: () => void }) {
  const view = timerView;
  const [pending, setPending] = createSignal<Trackable>();
  const [busy, setBusy] = createSignal(false);

  const act = async (op: () => Promise<unknown>, title: string) => {
    setBusy(true);
    await attempt(op, title);
    setBusy(false);
    props.onChanged?.();
  };
  const pick = (item: Trackable) => {
    if (isTarget(view(), item)) return;
    if (view().phase !== "idle") return setPending(item);
    void act(() => ipc.happy.timer.start(item), t("htm.err.start"));
  };
  const confirmSwitch = () => {
    const next = pending();
    setPending(undefined);
    if (next) void act(() => ipc.happy.timer.start(next), t("htm.err.switch"));
  };

  return (
    <div class="ht">
      <div class="ht__state">
        <StatusDot tone={PHASE[view().phase].tone} size={6} pulse={view().phase === "running"} />
        <span>{t(PHASE[view().phase].label)}</span>
        <Show when={view().stale}>
          <span class="ht__stale" title={t("htm.staleTip")}>{t("htm.stale")}</span>
        </Show>
      </div>
      <div class="ht__clock ui-tnum" data-phase={view().phase} role="timer" aria-label={t("htm.elapsed")}>{formatClock(elapsedSec(view(), props.now()))}</div>
      <Show when={view().phase !== "idle"} fallback={<p class="ht__hint">{t("htm.pickHint")}</p>}>
        <div class="ht__target">
          <span class="ht__title">{view().title}</span>
          <Show when={view().project}><span class="ht__project">{view().project}</span></Show>
        </div>
        <div class="ht__actions">
          <Show when={view().phase === "paused"} fallback={<Button icon={Pause} disabled={busy() || view().phase !== "running"} onClick={() => void act(ipc.happy.timer.pause, t("htm.err.pause"))}>{t("htm.pause")}</Button>}>
            <Button icon={Play} disabled={busy()} onClick={() => void act(ipc.happy.timer.resume, t("htm.err.resume"))}>{t("htm.resume")}</Button>
          </Show>
          <Button variant="danger" icon={Square} disabled={busy()} onClick={() => void act(ipc.happy.timer.stop, t("htm.err.stop"))}>{t("htm.stop")}</Button>
        </div>
      </Show>
      <Show when={pending()}>
        {(target) => (
          <div class="ht__switch" role="alertdialog" aria-label={t("htm.switch.label")}>
            <span>{tRich("htm.switch.text", { from: <strong>{view().title}</strong>, to: <strong>{target().title}</strong> }) /* i18n-ignore */}</span>
            <span class="ht__switch-actions">
              <Button size="sm" variant="primary" onClick={confirmSwitch}>{t("htm.switch.confirm")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(undefined)}>{t("htm.cancel")}</Button>
            </span>
          </div>
        )}
      </Show>
      <Picker busy={busy()} onPick={pick} />
    </div>
  );
}
