import { t } from "../../i18n";
import { ipc as defaultIpc, type Ipc } from "../../ipc";
import { openDockTab } from "../../platform/dock";
import { selectAgent } from "../../store/agents";
import { toast } from "../../ui-kit";

const message = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));

async function follow(kind: "resume" | "fork", runId: string, client: Ipc): Promise<boolean> {
  try {
    const run = await client.runs[kind](runId);
    toast.success(kind === "resume" ? t("inspector.run.resumed") : t("inspector.run.forked"), run.title);
    await selectAgent(run.id).catch(() => undefined);
    openDockTab("agents");
    return true;
  } catch (e) {
    const expired = (e as { code?: string })?.code === "transcriptExpired";
    toast.error(expired ? t("inspector.expired") : kind === "resume" ? t("inspector.run.resumeFail") : t("inspector.run.forkFail"), message(e));
    return false;
  }
}

/** Continues the same session. Resolves true when the new run is open in the Agents panel. */
export const resumeRun = (runId: string, client: Ipc = defaultIpc): Promise<boolean> => follow("resume", runId, client);
/** Starts a new run from the history of this one. */
export const forkRun = (runId: string, client: Ipc = defaultIpc): Promise<boolean> => follow("fork", runId, client);
