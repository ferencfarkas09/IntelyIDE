import { t } from "../../i18n";
import { Icon, Menu, ShieldAlert, Smartphone, TriangleAlert, Unplug } from "../../ui-kit";
import { openSettings } from "../../platform/settings";
import { panic, kill } from "./actions";
import { statusChipText } from "./logic";
import { remoteView } from "./state";
import "./remote.css";

/** Right side of the status bar while Remote is on: shows how many phones are paired and carries the kill switch and panic. */
export default function StatusChip() {
  const v = () => remoteView();
  return (
    <Menu
      aria-label={t("remote.name")}
      placement="top-end"
      trigger={(tp) => (
        <button type="button" {...tp} class="sb__item remote-chip" data-state={v()?.state} title={t("remote.chip.title")}>
          <Icon icon={v()?.state === "tampered" ? TriangleAlert : Smartphone} size={12} />
          <span>{statusChipText(v()?.state ?? "connecting", v()?.devices.length ?? 0)}</span>
        </button>
      )}
      items={[
        { label: t("remote.chip.openSettings"), icon: Smartphone, onSelect: () => openSettings("remote") },
        { type: "separator" },
        { label: t("remote.chip.kill"), icon: Unplug, danger: true, onSelect: () => void kill() },
        { label: t("remote.chip.panic"), icon: ShieldAlert, danger: true, onSelect: () => void panic() },
      ]}
    />
  );
}
