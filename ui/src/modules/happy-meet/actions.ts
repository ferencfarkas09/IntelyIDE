import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { toast } from "../../ui-kit";

/** Joins a meeting: Rust fetches a fresh link and opens the browser. Errors become a toast with the server's reason. */
export async function joinMeeting(id: string, title: string): Promise<void> {
  try {
    await ipc.happy.meet.join(id);
    toast.show({ title: t("hm.toast.opening"), description: title, tone: "info", duration: 3000 });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const credits = err.code === "INSUFFICIENT_CREDITS" || err.code === "insufficientCredits";
    toast.show({ title: credits ? t("hm.toast.credits") : t("hm.toast.joinFailed"), description: err.message, tone: credits ? "warn" : "danger" });
  }
}
