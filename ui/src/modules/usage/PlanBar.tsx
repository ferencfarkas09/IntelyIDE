import { createSignal, For, onCleanup, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { Button, Popover } from "../../ui-kit";
import { itemLabel, itemName, notCurrent, planRows, rowHint, rowName, shownItems, type PlanRow } from "./bar";
import { openUsage } from "./open";
import { planShown } from "./store";
import "./planbar.css";

/** The line under a row: its reset time, or, while its number is not current, when the last reading was made. */
const hintOf = (r: PlanRow, now: number): string => (notCurrent(r, now) ? t("planbar.updatingHint", { time: fmt.time(planShown()?.at ?? now) }) : rowHint(r, now));

/**
 * The plan-usage popover: every window the plan reports, with its percent, bar and reset time, and the way to the Usage view.
 * The rows scroll inside a box of capped height, so a plan with many model classes neither covers the bar nor opens scrolled
 * to its end; the button stays below them.
 */
export function PlanPopover(props: { now: number; close: () => void }) {
  return (
    <div class="pu" data-testid="plan-usage">
      <h2 class="pu__title">{t("planbar.title")}</h2>
      {/* a region in the Tab order: when the rows are taller than their box, the arrow keys, Page Up/Down and Home/End scroll it */}
      <div class="pu__rows" data-testid="plan-rows" tabindex="0" role="region" aria-label={t("planbar.rowsAria")}>
        <For each={planRows(planShown()?.limits)}>
          {(r) => (
            <div class="pu__row" data-tone={r.tone} data-current={notCurrent(r, props.now) ? "no" : undefined} data-testid={`plan-row-${r.kind}`}>
              <div class="pu__head">
                <span class="pu__name">{rowName(r)}</span>
                <span class="pu__pct ui-tnum">{notCurrent(r, props.now) ? t("planbar.updating") : `${r.percent}%`}</span>
              </div>
              <div class="pu__bar" role="img" aria-label={notCurrent(r, props.now) ? t("planbar.updatingAria", { name: rowName(r) }) : t("planbar.rowAria", { percent: r.percent })}>
                <div class="pu__bar-fill" style={{ width: notCurrent(r, props.now) ? "0%" : `${r.percent}%` }} />
              </div>
              <span class="pu__hint ui-tnum">{hintOf(r, props.now)}</span>
            </div>
          )}
        </For>
      </div>
      <Button
        variant="secondary"
        class="pu__open"
        onClick={() => {
          props.close();
          openUsage();
        }}
      >
        {t("planbar.open")}
      </Button>
    </div>
  );
}

function Item(props: { row: PlanRow; rows: PlanRow[]; now: number }) {
  const stale = () => notCurrent(props.row, props.now);
  const label = () => itemLabel(props.row, props.rows);
  return (
    <Popover
      placement="top-end"
      gap={8}
      aria-label={t("planbar.title")}
      class="pu-popover"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          class="pb"
          data-kind={props.row.kind}
          data-tone={stale() ? undefined : props.row.tone}
          data-current={stale() ? "no" : undefined}
          data-testid={`plan-item-${props.row.kind}`}
          aria-label={itemName(props.row, props.now, props.rows)}
          title={label()}
        >
          <span class="pb__label">{label()}</span>
          <span class="pb__track" aria-hidden="true">
            <span class="pb__fill" style={{ width: stale() ? "0%" : `${props.row.percent}%` }} />
          </span>
          <span class="pb__pct ui-tnum" aria-hidden="true">{stale() ? t("planbar.updating") : `${props.row.percent}%`}</span>
        </button>
      )}
    >
      {(api) => <PlanPopover now={props.now} close={api.close} />}
    </Popover>
  );
}

/** Bottom bar: "Weekly" and the week of each model class the plan names; a click on either opens the plan-usage popover. */
export default function PlanBar() {
  // the minute tick turns "Resets at 18:50" into "updating…" once the time has passed and no new reading came
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(tick));
  return (
    <Show when={shownItems().length > 0}>
      <span class="pb-group" role="group" aria-label={t("planbar.title")}>
        <For each={shownItems()}>{(r) => <Item row={r} rows={shownItems()} now={now()} />}</For>
      </span>
    </Show>
  );
}
