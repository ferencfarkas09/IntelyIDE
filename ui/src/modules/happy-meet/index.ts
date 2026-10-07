import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { openDockTab, registerDockTab } from "../../platform/dock";
import { registerStatusItem } from "../../platform/statusbar";
import { meetClock, meetItemVisible, meetView, providerState, relevantMeeting } from "../../store/happy";
import { Video } from "../../ui-kit";
import { joinMeeting } from "./actions";

const on = () => providerState("meet") === "ready" || providerState("meet") === "degraded";

/** Meet ((design notes: integrations-plan) 2.3): list live and scheduled meetings, join in the system browser. */
export function register(): void {
  registerStatusItem({ id: "happy-meet", align: "right", order: 6, component: lazy(() => import("./MeetItem")), when: meetItemVisible });
  registerDockTab({ id: "meet", get title() { return t("hm.name"); }, icon: Video, component: lazy(() => import("./MeetTab")) });
  registerCommand({ id: "meet.show", get title() { return t("hm.cmd.show"); }, get group() { return t("hm.name"); }, keywords: ["meeting", "video", "call", "standup"], when: on, run: () => openDockTab("meet") });
  registerCommand({
    id: "meet.join",
    get title() { return t("hm.cmd.join"); },
    get group() { return t("hm.name"); },
    keywords: ["meeting", "video", "call", "browser"],
    when: () => on() && !!relevantMeeting(meetView(), meetClock()),
    run: () => {
      const m = relevantMeeting(meetView(), meetClock());
      if (m) void joinMeeting(m.id, m.title);
    },
  });
}
