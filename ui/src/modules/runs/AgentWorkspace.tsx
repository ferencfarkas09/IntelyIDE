import { createEffect, lazy, Match, on, Show, Suspense, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { RunView } from "../../components/chat/ChatPanel";
import { StartingRunView } from "../../components/chat/Starting";
import { t } from "../../i18n";
import { execute } from "../../platform/commands";
import { agentPanel, agentPanelId, agentTabInstance, closeAgentPanel, showTabInAgent } from "../../platform/mode";
import { agentAnnouncement, agentRow, selectedAgentId } from "../../store/agents";
import { startingInFront, startingRun } from "../../store/starting";
import { Bot, Button, EmptyState, Plus, Spinner, Splitter } from "../../ui-kit";
import { InspectorSlot } from "./InspectorSlot";
import { NeedsYouInbox } from "./NeedsYouInbox";
import { paneState, shownCount } from "./panes";
import { markReviewed } from "./reviewed";
import { PaneBar, PaneGrid, trackPaneBounds } from "./RunPanes";
import { SessionsSidebar } from "./SessionsSidebar";
import { centreView } from "./state";

const AgentTabView = lazy(() => import("./AgentTabView").then((m) => ({ default: m.AgentTabView })));
import "../../components/chat/chat.css";
import "./runs.css";

function Centre() {
  // Opening a finished run is what "review" means: it leaves the Ready for review group.
  createEffect(() => {
    const row = agentRow(selectedAgentId());
    if (centreView() === "run" && row && row.status !== "running" && row.status !== "needsYou") markReviewed(row.agentId);
  });
  // A finished run that is on screen in another pane counts as seen too.
  createEffect(() => {
    if (centreView() !== "run" || shownCount() < 2) return;
    for (const id of paneState().slots.slice(0, shownCount())) {
      const r = agentRow(id);
      if (r && r.status !== "running" && r.status !== "needsYou") markReviewed(r.agentId);
    }
  });
  // Picking another run or opening the inbox leaves the tool (history, inspector, review) that was in the middle.
  createEffect(on([selectedAgentId, centreView], () => showTabInAgent(null), { defer: true }));
  const toolShown = () => !!agentTabInstance() || centreView() === "inbox";
  return (
    <main class="agent-centre" ref={trackPaneBounds}>
      <Show when={!toolShown()}>
        <PaneBar />
      </Show>
      <Switch>
        <Match when={agentTabInstance()}>{(tab) => <AgentTabView tab={tab()} />}</Match>
        <Match when={centreView() === "inbox"}>
          <NeedsYouInbox />
        </Match>
        <Match when={startingRun(startingInFront())}>
          {(run) => (
            <div class="chat agent-centre__run">
              <StartingRunView run={run()} />
            </div>
          )}
        </Match>
        <Match when={shownCount() > 1}>
          <PaneGrid />
        </Match>
        <Match when={selectedAgentId()}>
          {(id) => (
            <div class="chat agent-centre__run" data-testid="agent-run">
              <RunView agentId={id()} />
            </div>
          )}
        </Match>
        <Match when={true}>
          <EmptyState
            icon={Bot}
            title={t("runs.agent.pick")}
            description={t("runs.agent.pickDesc")}
            action={
              <Button variant="primary" icon={Plus} onClick={() => void execute("runs.new")}>
                {t("runs.newRun")}
              </Button>
            }
          />
        </Match>
      </Switch>
      <div class="ui-sr-only" role="status" aria-live="polite">
        {agentAnnouncement()}
      </div>
    </main>
  );
}

/** The column at the right edge (Team chat): what a module registered with `registerAgentPanel`. The panel draws its own header and gets `onClose`. */
function SidePanel() {
  const panel = () => {
    const id = agentPanelId();
    return id ? agentPanel(id) : undefined;
  };
  return (
    <Show when={panel()} keyed>
      {(p) => (
        <aside class="agent-panel" aria-label={p.title} data-testid="agent-panel">
          <Suspense fallback={<div class="agent-panel__loading"><Spinner /></div>}>
            <Dynamic component={p.component} onClose={closeAgentPanel} />
          </Suspense>
        </aside>
      )}
    </Show>
  );
}

/** Agent mode: sessions on the left, the transcript in the middle, the Inspector and, when one is open, a side panel such as Team chat on the right. */
export default function AgentWorkspace() {
  return (
    <div class="agent" data-testid="agent-workspace">
      <Splitter
        first={
          <Splitter
            first={<SessionsSidebar />}
            second={
              <Splitter first={<Centre />} second={<InspectorSlot />} primary="second" defaultSize={320} min={260} max={560} minOther={420} storageKey="agent.inspector" label={t("runs.agent.resizeInspector")} />
            }
            defaultSize={300}
            min={240}
            max={460}
            minOther={680}
            storageKey="agent.sessions"
            label={t("runs.agent.resizeSessions")}
          />
        }
        second={<SidePanel />}
        primary="second"
        collapsed={!agentPanelId()}
        defaultSize={380}
        min={300}
        max={720}
        minOther={760}
        storageKey="agent.panel"
        label={t("runs.agent.resizePanel")}
      />
    </div>
  );
}
