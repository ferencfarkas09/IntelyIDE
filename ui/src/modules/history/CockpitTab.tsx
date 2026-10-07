import type { TabInstance } from "../../platform/tabs";
import CockpitView from "./CockpitView";

/** Tab type `cockpit` (id `cockpit:<runId>`, params `{ runId, title?, role?, repoIds? }`): the same view as the panel, wide. */
export default function CockpitTab(props: { tab: TabInstance }) {
  const runId = () => String(props.tab.params?.runId ?? "");
  return (
    <div class="cp-tab">
      <CockpitView runId={runId()} />
    </div>
  );
}
