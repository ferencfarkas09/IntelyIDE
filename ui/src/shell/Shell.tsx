import { t } from "../i18n";
import { createEffect, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { firstDiffTarget } from "../components/diff/logic";
import { PushDialog } from "../components/push/PushDialog";
import { ResultsSheet } from "../components/results/ResultsSheet";
import { StatusBar } from "../components/StatusBar/StatusBar";
import { execute } from "../platform/commands";
import { appMode, modeView } from "../platform/mode";
import { overlays } from "../platform/overlay";
import { CommandPalette } from "../platform/hosts/CommandPalette";
import { EditorTabs } from "../platform/hosts/EditorTabs";
import { SettingsDialog } from "../platform/hosts/SettingsDialog";
import { BottomPanel, bottomItem, leftItem, ToolPanel } from "../platform/hosts/ToolWindow";
import { installKeymap } from "../platform/keymap";
import { ExecSurfaceConfirm } from "../components/commit/ExecSurfaceConfirm";
import { SensitiveConfirm } from "../components/commit/SensitiveConfirm";
import { selectedFile, setSelectedFile } from "../store/selection";
import { snapshots } from "../store/snapshots";
import { tabs } from "../platform/tabs";
import { dialogsRequested } from "../modules/branches/uiState";
import { repos, workspaceState } from "../store/workspace";
import { activeSummary } from "../store/workspaces";
import { Announcer, Splitter, TitleBar, Toaster } from "../ui-kit";
import { showDiffOnSelection } from "./builtin";
import { CENTRE_MIN, PANEL_MIN, panelVisible } from "./layout";
import { DockHost } from "./dock/DockHost";
import { CloseGuard } from "./CloseGuard";
import { Rail } from "./Rail";
import { Splash } from "./Splash";
import { MissingBanner, SurvivorsBanner } from "./workspace/Banners";
import { Welcome } from "./workspace/Welcome";
import { WorkspaceEmpty } from "./workspace/WorkspaceEmpty";
import { TitleCenter, TitleLeft, TitleRight } from "./TitleContent";
import "./shell.css";

const BranchDialogs = lazy(() => import("../modules/branches/BranchDialogs"));

function LeftToolWindow() {
  return <Show when={leftItem()} keyed>{(item) => <ToolPanel item={item} />}</Show>;
}

/** Centre area: the tab host, with the bottom tool window (terminal) under it while one is selected. The splitter stays
 * in the tree either way, so the tabs keep their editors, scroll positions and focus when the terminal comes and goes. */
function Centre() {
  return (
    <main class="centre">
      <Splitter
        direction="column"
        primary="second"
        first={<EditorTabs />}
        second={<Show when={bottomItem()} keyed>{(item) => <BottomPanel item={item} />}</Show>}
        collapsed={!bottomItem()}
        defaultSize={340}
        min={120}
        max={640}
        minOther={220}
        storageKey="shell.bottom-panel"
        label={t("shell.resizeBottom")}
      />
    </main>
  );
}

/** Opens the first changed file once it is known, so the diff area is never empty at startup. */
function openFirstChange() {
  let done = false;
  createEffect(() => {
    if (done) return;
    // A selection, or tabs restored from the workspace's saved state, mean the user already has something in front of them.
    if (selectedFile() || tabs().some((tab) => tab.type !== "diff")) {
      done = true;
      return;
    }
    const ids = repos().map((r) => r.id);
    const target = ids.length ? firstDiffTarget(ids, snapshots()) : undefined;
    if (target === undefined) return;
    done = true;
    if (target) setSelectedFile(target.repoId, target.path);
  });
}

/** The Agent workspace replaces the editor area while the mode is on; the editor stays mounted (hidden) so its state survives. */
function AgentWorkspace() {
  return (
    <Show when={appMode() === "agent" ? modeView("agent") : undefined} keyed>
      {(view) => (
        <div class="shell__mode shell__mode--agent">
          <Suspense>
            <Dynamic component={view.component} />
          </Suspense>
        </div>
      )}
    </Show>
  );
}

export function Shell() {
  openFirstChange();
  showDiffOnSelection();
  onMount(() => onCleanup(installKeymap((id) => execute(id).catch((err) => console.error(`Command ${id} failed`, err)))));

  return (
    <div class="shell" data-testid="shell">
      <TitleBar left={<TitleLeft />} center={<TitleCenter />} right={<TitleRight />} />
      <Show when={workspaceState() !== "empty"}>
        {/* The page after a switch puts the focus here and announces it ((design notes: workspaces-spec) 8.2); Welcome has its own heading. */}
        <h1 class="ui-sr-only" data-workspace-heading tabindex="-1">{activeSummary()?.name ?? t("switch.none")}</h1>
      </Show>
      <div class="wsbanners">
        <SurvivorsBanner />
        <MissingBanner />
      </div>
      <Show
        when={workspaceState() !== "empty"}
        fallback={<Welcome />}
      >
        <div class="shell__body">
          <Rail />
          <Show
            when={workspaceState() !== "ready" || repos().length > 0}
            fallback={<WorkspaceEmpty />}
          >
            <AgentWorkspace />
            <div class="shell__mode" hidden={appMode() === "agent"}>
              <DockHost>
                <Splitter
                  class="shell__split"
                  first={<LeftToolWindow />}
                  second={<Centre />}
                  collapsed={!panelVisible()}
                  defaultSize={400}
                  min={PANEL_MIN}
                  max={680}
                  minOther={CENTRE_MIN}
                  storageKey="shell.commit-panel"
                  label={t("shell.resizeCommit")}
                />
              </DockHost>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={workspaceState() !== "empty"}>
        <StatusBar />
      </Show>
      <ResultsSheet />
      <PushDialog />
      <SensitiveConfirm />
      <ExecSurfaceConfirm />
      <Show when={dialogsRequested()}>
        <BranchDialogs />
      </Show>
      <CommandPalette />
      <SettingsDialog />
      <For each={overlays()}>{(o) => <Dynamic component={o.component} />}</For>
      <CloseGuard />
      <Toaster placement="top-right" />
      <Announcer />
      <Splash />
    </div>
  );
}
