import { lazy } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { registerCommand } from "../../platform/commands";
import { openDockTab, registerDockTab } from "../../platform/dock";
import { registerStatusItem } from "../../platform/statusbar";
import { providerState, timerChipVisible, timerView } from "../../store/happy";
import { Clock } from "../../ui-kit";
import { attempt } from "./actions";

const on = () => providerState("timer") === "ready" || providerState("timer") === "degraded";
const tracking = () => timerView().phase === "running" || timerView().phase === "paused";

/** Time Tracer ((design notes: integrations-plan) 2.1). Everything heavy is a lazy chunk, fetched only once the timer is on. */
export function register(): void {
  registerStatusItem({ id: "happy-timer", align: "right", order: 5, component: lazy(() => import("./TimerChip")), when: timerChipVisible });
  registerDockTab({ id: "time", get title() { return t("htm.name"); }, icon: Clock, component: lazy(() => import("./TimeTab")) });
  registerCommand({ id: "time.show", get title() { return t("htm.cmd.show"); }, get group() { return t("htm.name"); }, keywords: ["timer", "tracker", "hours", "entries"], when: on, run: () => openDockTab("time") });
  registerCommand({ id: "time.stop", get title() { return t("htm.cmd.stop"); }, get group() { return t("htm.name"); }, keywords: ["timer", "end"], when: () => on() && tracking(), run: () => void attempt(ipc.happy.timer.stop, t("htm.err.stop")) });
  registerCommand({
    id: "time.pause",
    get title() { return t("htm.cmd.pause"); },
    get group() { return t("htm.name"); },
    keywords: ["timer", "break"],
    when: () => on() && tracking(),
    run: () => void attempt(timerView().phase === "paused" ? ipc.happy.timer.resume : ipc.happy.timer.pause, t("htm.err.change")),
  });
}
