import { onCleanup, onMount } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { toast } from "../../ui-kit";
import { applyNotice, checkNow, errorText, markDisclosed } from "./state";

/** Result of a manual check as a toast. */
export async function manualCheckToast(): Promise<void> {
  try {
    const n = await checkNow();
    if (n.state === "available" && n.latest) toast.info(t("updates.toast.available", { version: n.latest.version }));
    else if (n.state === "upToDate") toast.success(t("updates.toast.upToDate", { version: n.currentVersion }));
    else toast.warn(t("updates.toast.failed"), errorText(n.error));
  } catch {
    toast.warn(t("updates.toast.failed"), errorText("network"));
  }
}

/** Overlay: reads the notice, follows `update:status`, runs the menu item and shows the one-time disclosure. Renders nothing. */
export default function UpdatesWatcher() {
  onMount(() => {
    const offs = [ipc.updates.onStatus(applyNotice), ipc.updates.onMenuCheck(() => void manualCheckToast())];
    onCleanup(() => offs.forEach((off) => off()));
    void ipc.updates.status().then((n) => {
      applyNotice(n);
      if (n.disclosedAt === undefined && n.state !== "disabled") {
        // Shown before the first automatic check: the backend makes no request until it is recorded.
        toast.show({ title: t("updates.disclosure.title"), description: t("updates.disclosure"), tone: "info", duration: 0 });
        void markDisclosed();
      }
    }, () => undefined);
  });
  return null;
}
