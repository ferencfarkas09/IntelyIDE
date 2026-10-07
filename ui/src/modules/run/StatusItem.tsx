import { t } from "../../i18n";
import { liveServers, formatRss, totalRssMb } from "../../store/devservers";
import { setToolWindow } from "../../platform/rail";
import { StatusDot, Tooltip } from "../../ui-kit";

/** Status bar chip: how many dev servers run and what they hold. Click opens the Run panel. */
export default function RunStatusItem() {
  const n = () => liveServers().length;
  return (
    <Tooltip label={liveServers().map((s) => `${s.runner}${s.ports[0] ? ` :${s.ports[0]}` : ""}`).join("\n") || t("run.noServers")}>
      <button type="button" class="run-status" aria-label={t("run.statusAria", { count: n(), rss: formatRss(totalRssMb()) })} onClick={() => setToolWindow("bottom", "run")}>
        <StatusDot tone="ok" size={6} />
        <span class="ui-tnum">{t("run.statusText", { count: n() })}</span>
        <span class="run-status__rss ui-tnum">{formatRss(totalRssMb())}</span>
      </button>
    </Tooltip>
  );
}
