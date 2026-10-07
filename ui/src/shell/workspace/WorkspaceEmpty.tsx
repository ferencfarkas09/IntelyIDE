import { t } from "../../i18n";
import { execute } from "../../platform/commands";
import { Button, EmptyState, FolderGit2 } from "../../ui-kit";

/** An open workspace without repositories (3.13): the rail stays, the main area says what to do next. */
export function WorkspaceEmpty() {
  return (
    <div class="ws-empty" data-testid="workspace-empty">
      <EmptyState
        icon={FolderGit2}
        title={t("ws.emptyTitle")}
        description={t("ws.emptyBody")}
        action={
          <div class="ws-empty__actions">
            <Button variant="primary" onClick={() => void execute("workspace.addRepo")}>{t("ws.emptyAdd")}</Button>
            <Button variant="secondary" onClick={() => void execute("workspace.scan")}>{t("ws.emptyScan")}</Button>
            <Button variant="ghost" onClick={() => void execute("workspace.switch")}>{t("ws.emptyOther")}</Button>
          </div>
        }
      />
    </div>
  );
}
