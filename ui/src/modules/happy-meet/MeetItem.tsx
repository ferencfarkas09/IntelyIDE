import { Show } from "solid-js";
import { t } from "../../i18n";
import { openDockTab } from "../../platform/dock";
import { meetClock, meetView, relevantMeeting } from "../../store/happy";
import { Icon, StatusDot, Tooltip, Video } from "../../ui-kit";
import { joinMeeting } from "./actions";
import { barText } from "./logic";
import "./meet.css";

/** Shown only while a meeting is live or about to start. The label opens the Meet tab, "Join" opens the browser. */
export default function MeetItem() {
  const m = () => relevantMeeting(meetView(), meetClock());
  return (
    <Show when={m()}>
      {(meeting) => (
        <span class="happy-meet" data-live={meeting().status === "live" ? "" : undefined}>
          <Tooltip label={t("hm.showTip")}>
            <button type="button" class="sb__item sb__attention happy-meet__label" onClick={() => openDockTab("meet")}>
              <Show when={meeting().status === "live"} fallback={<Icon icon={Video} size={12} />}>
                <StatusDot tone="accent" size={6} pulse />
              </Show>
              <span class="ui-truncate">{barText(meeting(), meetClock())}</span>
            </button>
          </Tooltip>
          <Tooltip label={t("hm.browserTip")}>
            <button type="button" class="happy-meet__join" onClick={() => void joinMeeting(meeting().id, meeting().title)}>{t("hm.join")}</button>
          </Tooltip>
        </span>
      )}
    </Show>
  );
}
