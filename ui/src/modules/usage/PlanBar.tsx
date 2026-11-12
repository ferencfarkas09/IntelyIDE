import { createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, Popover } from "../../ui-kit";
import { barItems, itemLabel, itemName, planRows, rowHint, rowName, type PlanRow } from "./bar";
import { openUsage } from "./open";
import { limits } from "./store";
import "./planbar.css";

/** The plan-usage popover: every window the plan reports, with its percent, bar and reset time, and the way to the Usage view. */
export function PlanPopover(props: { now: number; close: () => void }) {
  return (
    <div class="pu" data-testid="plan-usage">
      <h2 class="pu__title">{t("planbar.title")}</h2>
      <For each={planRows(limits())}>
        {(r) => (
          <div class="pu__row" data-tone={r.tone} data-testid={`plan-row-${r.kind}`}>
            <div class="pu__head">
              <span class="pu__name">{rowName(r)}</span>
              <span class="pu__pct ui-tnum">{r.percent}%</span>
            </div>
            <div class="pu__bar" role="img" aria-label={t("planbar.rowAria", { percent: r.percent })}>
              <div class="pu__bar-fill" style={{ width: `${r.percent}%` }} />
            </div>
            <span class="pu__hint ui-tnum">{rowHint(r, props.now)}</span>
          </div>
        )}
      </For>
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

function Item(props: { row: PlanRow; now: number }) {
  return (
    <Popover
      placement="top-end"
      gap={8}
      aria-label={t("planbar.title")}
      class="pu-popover"
      trigger={(p) => (
        <button {...p} type="button" class="pb" data-tone={props.row.tone} data-testid={`plan-item-${props.row.kind}`} aria-label={itemName(props.row, props.now)}>
          <span class="pb__label">{itemLabel(props.row)}</span>
          <span class="pb__track" aria-hidden="true">
            <span class="pb__fill" style={{ width: `${props.row.percent}%` }} />
          </span>
          <span class="pb__pct ui-tnum" aria-hidden="true">{props.row.percent}%</span>
        </button>
      )}
    >
      {(api) => <PlanPopover now={props.now} close={api.close} />}
    </Popover>
  );
}

/** Bottom bar: "Weekly" and the week of each model class the plan names; a click on either opens the plan-usage popover. */
export default function PlanBar() {
  // the reset time is told as a clock time; the minute tick only turns "Resets at 18:50" into "Resets now" in time
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(tick));
  return (
    <Show when={barItems(limits()).length > 0}>
      <span class="pb-group" role="group" aria-label={t("planbar.title")}>
        <For each={barItems(limits())}>{(r) => <Item row={r} now={now()} />}</For>
      </span>
    </Show>
  );
}
