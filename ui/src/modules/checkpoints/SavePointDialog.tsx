import { createEffect, createSignal, on } from "solid-js";
import { t } from "../../i18n";
import { Button, CircleAlert, Dialog, Input, toast } from "../../ui-kit";
import { checkpointsApi } from "./api";
import { cleanLabel, errorText } from "./logic";
import { checkpointsChanged } from "./store";

/** Names a save point of every repository of the run, also when nothing changed since the last step. */
export function SavePointDialog(props: { open: boolean; runId: string; onClose: () => void }) {
  const [label, setLabel] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  createEffect(on(() => props.open, (open) => open && (setLabel(""), setError(undefined))));
  async function save(e?: Event) {
    e?.preventDefault();
    const name = cleanLabel(label()) || t("checkpoints.save.defaultLabel");
    setBusy(true);
    setError(undefined);
    try {
      const seq = await checkpointsApi().save(props.runId, name);
      checkpointsChanged();
      toast.success(t("checkpoints.save.done", { name, n: seq }));
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="sm"
      title={t("checkpoints.save.title")}
      description={t("checkpoints.save.desc")}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t("checkpoints.restore.cancel")}
          </Button>
          <Button variant="primary" loading={busy()} onClick={() => void save()}>
            {t("checkpoints.save.button")}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void save(e)}>
        <Input data-autofocus size="md" maxLength={80} aria-label={t("checkpoints.save.label")} placeholder={t("checkpoints.save.placeholder")} value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />
      </form>
      {error() && (
        <div class="cp-restore__error" role="alert">
          <CircleAlert size={14} /> {error()}
        </div>
      )}
    </Dialog>
  );
}
