import { execute } from "../../platform/commands";
import { toast } from "../../ui-kit";
import { t } from "../../i18n";

/** Opens the file in an editor tab at the match, through the editor module's `editor.openFile` command. */
export function openHit(repoId: string, path: string, line: number, col: number): void {
  void execute("editor.openFile", { repoId, path, line, column: col }).then((ran) => {
    if (!ran) toast.info(t("search.noEditor"), `${path}:${line}:${col}`);
  });
}
