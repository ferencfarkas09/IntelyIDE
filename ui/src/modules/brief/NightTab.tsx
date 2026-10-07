import { onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { Moon, SegmentedControl, Sun } from "../../ui-kit";
import BriefView from "./BriefView";
import QueueView from "./QueueView";
import { brief, loadBrief, loadError, setView, startNight, stopNight, view, type View } from "./store";
import "./brief.css";

/** Tab type `nightqueue`: the evening queue and the Morning brief side by side. */
export default function NightTab() {
  onMount(() => {
    void startNight();
    if (view() === "brief" || !brief()) void loadBrief();
  });
  onCleanup(stopNight);
  return (
    <div class="nt">
      <div class="nt__bar">
        <SegmentedControl<View>
          aria-label={t("night.view.aria")}
          value={view()}
          onChange={(v) => {
            setView(v);
            if (v === "brief") void loadBrief();
          }}
          options={[
            { value: "queue", icon: Moon, label: t("night.view.queue") },
            { value: "brief", icon: Sun, label: t("night.view.brief") },
          ]}
        />
      </div>
      <Show when={loadError()}><p class="nq__note" data-tone="danger">{loadError()}</p></Show>
      <div class="nt__body">
        <Show when={view() === "queue"} fallback={<BriefView />}><QueueView /></Show>
      </div>
    </div>
  );
}
