import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { isForeign } from "../../store/agentScope";
import type { AgentRow } from "../../store/agents";
import { IconButton, Save, toast, Undo2 } from "../../ui-kit";
import { checkpointsApi } from "./api";
import { errorText, undoTarget } from "./logic";
import { openRestore, openSavePoint } from "./store";

/** Opens Undo last step for a run: finds the step before the newest change and shows its dry run. Never restores by itself. */
export async function startUndo(runId: string): Promise<boolean> {
  try {
    const target = undoTarget(await checkpointsApi().list(runId));
    if (!target) {
      toast.info(t("checkpoints.undo.nothing"));
      return false;
    }
    openRestore({ runId, seq: target.seq, mode: "undo" });
    return true;
  } catch (e) {
    toast.error(t("checkpoints.undo.failed"), errorText(e));
    return false;
  }
}

/** Save point and Undo last step in the run header. A run of another workspace or on a server gets neither. */
export default function HeaderButtons(props: { agent: AgentRow }) {
  const [busy, setBusy] = createSignal(false);
  const a = () => props.agent;
  const active = () => a().status === "running" || a().status === "needsYou";
  const usable = () => !isForeign(a().repoIds) && !a().location && a().repoIds.length > 0;
  return (
    <Show when={usable()}>
      <IconButton icon={Save} size="sm" label={t("checkpoints.save.title")} tooltip={t("checkpoints.save.tip")} onClick={() => openSavePoint(a().agentId)} />
      <IconButton
        icon={Undo2}
        size="sm"
        label={t("checkpoints.undo.button")}
        tooltip={active() ? t("checkpoints.gate.active") : t("checkpoints.undo.tip")}
        disabled={active()}
        loading={busy()}
        onClick={async () => {
          setBusy(true);
          await startUndo(a().agentId);
          setBusy(false);
        }}
      />
    </Show>
  );
}
