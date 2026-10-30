import { Show } from "solid-js";
import { RestoreDialog } from "./RestoreDialog";
import { SavePointDialog } from "./SavePointDialog";
import { closeRestore, closeSavePoint, restoreRequest, savePointFor } from "./store";

/** The overlay of the module: the Save point and Restore dialogs, opened from the header, the timeline or the palette. */
export default function CheckpointDialogs() {
  return (
    <>
      <Show when={savePointFor()}>{(runId) => <SavePointDialog open={true} runId={runId()} onClose={closeSavePoint} />}</Show>
      <Show when={restoreRequest()}>{(req) => <RestoreDialog open={true} runId={req().runId} seq={req().seq} mode={req().mode} onClose={closeRestore} />}</Show>
    </>
  );
}
