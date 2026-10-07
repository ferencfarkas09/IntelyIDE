import { Button, Dialog, SendHorizontal } from "../../ui-kit";
import { t } from "../../i18n";
import "./commit.css";
import { answerExecSurfaceConfirm, execSurfaceConfirmRequest } from "./execSurface";
import { ExecFileGroups } from "./ExecSurfaceBanner";

/** Part of Commit and Push: the files that run code, once more, before they leave the machine. The human can always continue. */
export function ExecSurfaceConfirm() {
  return (
    <Dialog
      open={execSurfaceConfirmRequest() !== null}
      onClose={() => answerExecSurfaceConfirm(false)}
      role="alertdialog"
      size="sm"
      title={t("commit.exec.confirmTitle")}
      description={t("commit.exec.confirmDesc")}
      footer={
        <>
          <Button variant="ghost" onClick={() => answerExecSurfaceConfirm(false)} data-autofocus>
            {t("comp.cancel")}
          </Button>
          <Button variant="primary" icon={SendHorizontal} onClick={() => answerExecSurfaceConfirm(true)}>
            {t("commit.exec.confirmAnyway")}
          </Button>
        </>
      }
    >
      <ExecFileGroups files={execSurfaceConfirmRequest()?.files ?? []} />
    </Dialog>
  );
}
