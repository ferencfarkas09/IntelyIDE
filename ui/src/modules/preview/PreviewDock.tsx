import { Show } from "solid-js";
import { t } from "../../i18n";
import { Globe } from "../../ui-kit";
import { EmptyState } from "../../ui-kit";
import { dockRepoId, setDockRepo } from "./state";
import { PreviewView } from "./PreviewView";

/** The right dock tab: the same view beside the code, for the repo of the open file (or the one picked here). */
export default function PreviewDock() {
  return (
    <Show when={dockRepoId()} fallback={<EmptyState icon={Globe} title={t("pv.dock.none.title")} description={t("pv.dock.none.desc")} />}>
      {(id) => <PreviewView repoId={id()} mode="dock" onRepoChange={setDockRepo} />}
    </Show>
  );
}
