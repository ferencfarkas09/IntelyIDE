import { t } from "../../i18n";
import { toast } from "../../ui-kit";
import { ipc } from "../../ipc";
import { applyRemote } from "./state";

const message = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** Closes every phone session at once and switches Remote off. Devices stay paired. */
export async function kill(): Promise<boolean> {
  try {
    await applyRemote(ipc.remote.kill);
    toast.show({ title: t("remote.toast.killed"), tone: "ok", duration: 4000 });
    return true;
  } catch (e) {
    toast.show({ title: t("remote.toast.killFailed", { error: message(e) }), tone: "danger", duration: 8000 });
    return false;
  }
}

/** Revokes every device, rotates the key, room and token, wipes the relay room and switches Remote off. Asks first. */
export async function panic(confirmed = false): Promise<boolean> {
  if (!confirmed && !globalThis.confirm?.(t("remote.confirm.panic"))) return false;
  try {
    await applyRemote(ipc.remote.panic);
    toast.show({ title: t("remote.toast.panicked"), tone: "ok", duration: 5000 });
    return true;
  } catch (e) {
    toast.show({ title: t("remote.toast.panicFailed", { error: message(e) }), tone: "danger", duration: 8000 });
    return false;
  }
}
