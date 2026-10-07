import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import { tRich } from "../../components/richText";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { openDockTab } from "../../platform/dock";
import { timerView } from "../../store/happy";
import { Button, Clock, Icon, Pause, Play, Popover } from "../../ui-kit";
import { createTicker } from "./actions";
import { counting, elapsedSec, formatClock, formatTotal, todayRange } from "./logic";
import { TimerControls } from "./TimerControls";
import "./timer.css";

const ICON = { idle: Clock, running: Play, paused: Pause, break: Pause } as const;

/** The status-bar item: a locally ticking clock, and a popover with the task picker and the start/stop/pause actions. */
export default function TimerChip() {
  const view = timerView;
  const now = createTicker(() => counting(view()));
  const [open, setOpen] = createSignal(false);
  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="top-end"
      aria-label={t("htm.chip.label")}
      class="ht-popover"
      trigger={(p) => (
        <button {...p} type="button" class="sb__item sb__attention happy-chip" data-phase={view().phase} data-stale={view().stale ? "" : undefined} aria-label={view().phase === "idle" ? t("htm.chip.idle") : t("htm.chip.tracking", { title: view().title })}>
          <Icon icon={ICON[view().phase]} size={12} />
          <Show when={view().phase !== "idle"} fallback={<span>{t("htm.chip.timer")}</span>}>
            <span class="happy-chip__clock ui-tnum">{formatClock(elapsedSec(view(), now()))}</span>
            <span class="happy-chip__title ui-truncate">{view().title}</span>
          </Show>
        </button>
      )}
    >
      {(api) => <ChipPopover now={now} close={api.close} />}
    </Popover>
  );
}

function ChipPopover(props: { now: () => number; close: () => void }) {
  const [today, { refetch }] = createResource(() => ipc.happy.timer.entries(...todayRange(Date.now())).catch(() => undefined));
  createEffect(on(() => timerView().phase, () => void refetch(), { defer: true }));
  const total = () => {
    const day = today();
    if (!day) return undefined;
    // The running entry counts up with the clock, the rest comes from the server.
    const running = day.entries.find((e) => e.endedAtMs == null);
    return day.totalSeconds - (running?.seconds ?? 0) + (running ? elapsedSec(timerView(), props.now()) : 0);
  };
  return (
    <div class="ht-pop">
      <TimerControls now={props.now} />
      <div class="ht-pop__foot">
        <span class="ht-pop__today">{tRich("htm.pop.today", { total: <strong class="ui-tnum">{total() === undefined ? "—" : formatTotal(total()!)}</strong> })}</span>
        <Button size="sm" variant="ghost" onClick={() => { props.close(); openDockTab("time"); }}>{t("htm.pop.openTab")}</Button>
      </div>
    </div>
  );
}
