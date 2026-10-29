import { createResource, Show } from "solid-js";
import { t } from "../../../i18n";
import type { WidgetProps } from "../../../platform/widgets";
import { Button, KpiTile, Sun } from "../../../ui-kit";
import { nightApi } from "../../brief/api";
import { openNight } from "../../brief/open";
import { formatUsd } from "../../usage/format";
import { CardEmpty, CardError, CardLoading, errorText } from "../parts";

/** Morning brief: what the runs of the night (or since yesterday) did, from the night queue's brief. Only while that extra is on. */
export default function MorningBrief(props: WidgetProps) {
  const [brief, { refetch }] = createResource(props.refreshTick, () => nightApi().brief());
  return (
    <Show when={brief.state !== "unresolved" && brief.state !== "pending"} fallback={<CardLoading />}>
      <Show when={brief.state !== "errored"} fallback={<CardError message={errorText(brief.error)} onRetry={() => void refetch()} />}>
        <Show when={brief.latest}>
          {(b) => (
            <Show when={b().totals.runs > 0} fallback={<CardEmpty icon={Sun} title={t("dash.brief.empty")} why={t("dash.brief.emptyWhy")} />}>
              <div class="dash-kpis" data-size={props.size}>
                <KpiTile label={t("dash.brief.runs")} value={String(b().totals.runs)} />
                <KpiTile label={t("dash.brief.failed")} value={String(b().totals.failed)} class={b().totals.failed > 0 ? "dash-kpi--danger" : undefined} />
                <KpiTile label={t("dash.brief.needsYou")} value={String(b().totals.needsYou)} class={b().totals.needsYou > 0 ? "dash-kpi--warn" : undefined} />
              </div>
              <p class="dash-line ui-tnum">
                {t("dash.brief.files", { files: b().totals.files, add: b().totals.additions, del: b().totals.deletions })}
                <Show when={typeof b().totals.costUsd === "number"}> · {formatUsd(b().totals.costUsd!)}</Show>
              </p>
            </Show>
          )}
        </Show>
        <div class="dash-actions">
          <Button size="sm" variant="ghost" onClick={() => void openNight("brief")}>
            {t("dash.brief.open")}
          </Button>
        </div>
      </Show>
    </Show>
  );
}
