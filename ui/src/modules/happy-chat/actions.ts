import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { toast } from "../../ui-kit";
import { safeHttpsUrl } from "./logic";

/** Opens a link of a message in the system browser. Only https passes (checked here and again in Rust); the URL is never logged or toasted. */
export async function openLink(href: string): Promise<void> {
  const url = safeHttpsUrl(href);
  if (!url) return;
  try {
    await ipc.happy.openExternal(url);
  } catch (e) {
    const message = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : t("hc.err.browser");
    toast.show({ title: t("hc.toast.openLinkFailed"), description: message, tone: "danger" });
  }
}
