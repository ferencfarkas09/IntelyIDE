import { t } from "../i18n";
import { lazy, Suspense, type JSX } from "solid-js";
import type { RepoConfig, RepoSnapshot } from "../ipc";
import { popupRepo, setPopupRepo } from "../modules/branches/uiState";
import { Popover, Spinner, type PopoverTriggerProps } from "../ui-kit";

const BranchPanel = lazy(() => import("../modules/branches/BranchPanel"));

export interface BranchPopupProps {
  repo: RepoConfig;
  snapshot?: RepoSnapshot;
  trigger: (props: PopoverTriggerProps) => JSX.Element;
}

/** The branch switcher on a repo pill; the body lives in the branches module and loads on first open. */
export function BranchPopup(props: BranchPopupProps) {
  return (
    <Popover
      trigger={props.trigger}
      placement="bottom-start"
      aria-label={t("shell.branches", { name: props.repo.name })}
      class="bp"
      open={popupRepo() === props.repo.id}
      onOpenChange={(open) => setPopupRepo(open ? props.repo.id : popupRepo() === props.repo.id ? null : popupRepo())}
    >
      {(api) => (
        <Suspense fallback={<div class="tool-loading bp__loading"><Spinner label={t("shell.loadingBranches")} /></div>}>
          <BranchPanel repo={props.repo} snapshot={props.snapshot} close={api.close} />
        </Suspense>
      )}
    </Popover>
  );
}
