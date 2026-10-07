import { DiffView } from "../components/diff/DiffView";
import { Button, EmptyState, EyeOff } from "../ui-kit";
import { diffPreview, setDiffPreview } from "./layout";
import { t } from "../i18n";

/** The `diff` tab type: follows the file selected in the Commit panel; the empty state stays while the preview is off. */
export default function DiffTab() {
  return (
    <>
      {diffPreview() ? (
        <DiffView />
      ) : (
        <EmptyState
          icon={EyeOff}
          title={t("shell.diffOff")}
          description={t("shell.diffOffDesc")}
          action={
            <Button size="sm" variant="secondary" onClick={() => setDiffPreview(true)}>
              {t("shell.diffShow")}
            </Button>
          }
        />
      )}
    </>
  );
}
