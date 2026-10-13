import { lazy, Show, Suspense } from "solid-js";
import { ChangesTree } from "../components/changes/ChangesTree";
import { CommitPanel } from "../components/commit/CommitPanel";
import { Toolbar } from "../components/Toolbar/Toolbar";
import { Spinner } from "../ui-kit";
import { commitView } from "./layout";
import { t } from "../i18n";

const StashPanel = lazy(() => import("../modules/branches/StashPanel"));
const ServerChangesPanel = lazy(() => import("../modules/servers/view/ServerChangesPanel"));

export function CommitToolWindow() {
  return (
    <section class="tool" aria-label={t("commit.panel")}>
      <Toolbar />
      <Show
        when={commitView() === "commit"}
        fallback={
          <Suspense fallback={<div class="tool-loading"><Spinner /></div>}>
            <StashPanel />
          </Suspense>
        }
      >
        <ChangesTree />
        <Suspense>
          <ServerChangesPanel />
        </Suspense>
        <CommitPanel />
      </Show>
    </section>
  );
}
