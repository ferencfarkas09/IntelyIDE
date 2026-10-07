import { collapseAll, expandAll, locateSelected, requestScroll } from "../changes/treeState";
import { execute } from "../../platform/commands";
import { commitView, diffPreview, setCommitView, setDiffPreview } from "../../shell/layout";
import { pullRepo } from "../../store/actions";
import { selectedFile } from "../../store/selection";
import { isRefreshing, refreshSnapshots, snapshots } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { Archive, ArrowDownToLine, ChevronsDownUp, ChevronsUpDown, Eye, IconButton, LocateFixed, RefreshCw, SegmentedControl, Undo2, toast } from "../../ui-kit";
import { t } from "../../i18n";
import "./toolbar.css";

/** Header of the Commit tool window: actions on the left, the Commit / Stash tabs below. */
export function Toolbar() {
  const ids = () => repos().map((r) => r.id);

  const update = () => {
    const behind = repos().filter((r) => (snapshots()[r.id]?.behind ?? 0) > 0);
    if (behind.length === 0) return toast.info(t("toolbar.upToDate"), t("toolbar.upToDateDesc"));
    behind.forEach((r) => void pullRepo(r.id));
  };
  const locate = () => {
    const key = locateSelected();
    if (key) requestScroll(key);
  };

  return (
    <div class="tb">
      <div class="tb__actions" role="toolbar" aria-label={t("changes.tree")}>
        <IconButton icon={RefreshCw} label={t("comp.refresh")} shortcut={["⌘", "R"]} size="sm" loading={isRefreshing()} onClick={() => void refreshSnapshots(null)} />
        <IconButton icon={Undo2} label={t("toolbar.rollback")} tooltip={t("toolbar.rollbackTip")} shortcut={["⌘", "⌥", "Z"]} size="sm" onClick={() => void execute("git.rollback")} />
        <IconButton icon={ArrowDownToLine} label={t("toolbar.update")} tooltip={t("toolbar.updateTip")} size="sm" onClick={update} />
        <IconButton icon={Eye} label={t("toolbar.diffPreview")} size="sm" pressed={diffPreview()} onClick={() => setDiffPreview(!diffPreview())} />
        <span class="tb__sep" aria-hidden="true" />
        <IconButton icon={LocateFixed} label={t("toolbar.locate")} tooltip={selectedFile() ? t("toolbar.locate") : t("toolbar.locateNone")} size="sm" disabled={!selectedFile()} onClick={locate} />
        <span class="tb__grow" />
        <IconButton icon={ChevronsUpDown} label={t("toolbar.expandAll")} size="sm" onClick={() => expandAll(ids())} />
        <IconButton icon={ChevronsDownUp} label={t("toolbar.collapseAll")} size="sm" onClick={() => collapseAll(ids())} />
      </div>
      <div class="tb__tabs">
        <SegmentedControl
          size="sm"
          aria-label={t("toolbar.window")}
          value={commitView()}
          onChange={setCommitView}
          options={[
            { value: "commit", label: t("cmd.commit") },
            { value: "stash", label: t("toolbar.stash"), icon: Archive },
          ]}
        />
      </div>
    </div>
  );
}

