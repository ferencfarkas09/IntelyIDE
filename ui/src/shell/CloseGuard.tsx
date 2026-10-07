import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { armCloseGuard, closeDialogOpen, endSessions, exitApp, onCloseRequested, saveAllUnsaved, sessionCopy, sessionTitles, unsavedTitles } from "../platform/closeGuard";
import { Button, Dialog, toast } from "../ui-kit";
import { t } from "../i18n";

/** "a.ts", "a.ts and b.ts", "a.ts, b.ts and 3 more" */
export function listTitles(titles: readonly string[], max = 3): string {
  if (titles.length <= 1) return titles.join("");
  if (titles.length <= max) return t("shell.close.and", { head: titles.slice(0, -1).join(", "), last: titles[titles.length - 1] });
  return t("shell.close.andMore", { head: titles.slice(0, max).join(", "), n: titles.length - max });
}

/**
 * Closing the window or quitting while buffers are unsaved: the host holds the close back (it is armed only while
 * something is unsaved) and this dialog asks Save all / Don't save / Cancel. Live sessions (an open Production
 * connection, registered as a `"session"` source) arm it too and get their own wording: Cancel / Disconnect and quit.
 */
export function CloseGuard() {
  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const count = () => unsavedTitles().length;
  const sessions = () => sessionTitles().length;

  createEffect(() => armCloseGuard(count() + sessions() > 0));
  createEffect(on(open, closeDialogOpen, { defer: true }));
  onMount(() =>
    onCleanup(
      onCloseRequested(() => {
        if (count() + sessions() > 0) setOpen(true);
        else exitApp();
      }),
    ),
  );
  // Everything got saved (or the sessions ended) elsewhere while the dialog was up.
  createEffect(() => count() + sessions() === 0 && setOpen(false));

  async function leave() {
    setSaving(true);
    try {
      await endSessions();
    } finally {
      setSaving(false);
      exitApp();
    }
  }

  async function saveAndLeave() {
    setSaving(true);
    try {
      if (await saveAllUnsaved()) return exitApp();
      toast.show({ tone: "warn", title: t("shell.close.notSaved"), description: t("shell.close.notSavedDesc") });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Show
      when={count() > 0 || !sessionCopy()}
      fallback={
        <Dialog
          open={open()}
          onClose={() => setOpen(false)}
          title={sessionCopy()?.title ?? ""}
          description={sessionCopy()?.description}
          size="sm"
          role="alertdialog"
          footer={
            <>
              <Button variant="ghost" data-autofocus onClick={() => setOpen(false)}>{t("comp.cancel")}</Button>
              <Button variant="primary" loading={saving()} onClick={() => void leave()}>{sessionCopy()?.confirm ?? ""}</Button>
            </>
          }
        />
      }
    >
      <Dialog
        open={open()}
        onClose={() => setOpen(false)}
        title={count() === 1 ? t("shell.close.titleOne") : t("shell.close.titleMany", { count: count() })}
        description={t(count() === 1 ? "shell.close.descOne" : "shell.close.descMany", { titles: listTitles(unsavedTitles()) })}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("comp.cancel")}</Button>
            <Button variant="danger" disabled={saving()} onClick={exitApp}>{t("shell.close.dontSave")}</Button>
            <Button variant="primary" data-autofocus loading={saving()} onClick={() => void saveAndLeave()}>{count() === 1 ? t("shell.close.save") : t("shell.close.saveAll")}</Button>
          </>
        }
      />
    </Show>
  );
}
