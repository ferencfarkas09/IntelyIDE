import { Show, type JSX } from "solid-js";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "./icons";
import { t } from "../i18n";
import { Icon } from "./Icon";

export interface KpiDelta {
  /** Shown as is, e.g. "+12%" or "3 more". */
  value: string;
  direction: "up" | "down" | "flat";
  /** Whether up is good (default). Spend and errors read better when they go down: pass false. */
  upIsGood?: boolean;
}

export interface KpiTileProps {
  label: JSX.Element;
  /** The big number, already formatted. */
  value: JSX.Element;
  /** A small unit or suffix next to the value ("tokens", "%"). */
  unit?: JSX.Element;
  delta?: KpiDelta;
  /** One quiet line under the value. */
  hint?: JSX.Element;
  /** Slot for a <Sparkline> (or any small chart). */
  sparkline?: JSX.Element;
  class?: string;
}

/** The tone of a delta: good news green, bad news red, no change neutral. */
export function deltaTone(d: KpiDelta): "ok" | "danger" | "neutral" {
  if (d.direction === "flat") return "neutral";
  return (d.direction === "up") === (d.upIsGood ?? true) ? "ok" : "danger";
}

const ARROWS = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;

/** A dashboard tile: label, a big number, an optional change chip and a sparkline slot. */
export function KpiTile(props: KpiTileProps) {
  const spoken = (d: KpiDelta) => (d.direction === "up" ? t("kit.deltaUp", { value: d.value }) : d.direction === "down" ? t("kit.deltaDown", { value: d.value }) : d.value);
  return (
    <div class={props.class ? `ui-kpi ${props.class}` : "ui-kpi"} role="group">
      <div class="ui-kpi__label">{props.label}</div>
      <div class="ui-kpi__row">
        <div class="ui-kpi__value ui-tnum">
          {props.value}
          <Show when={props.unit !== undefined}>
            <span class="ui-kpi__unit">{props.unit}</span>
          </Show>
        </div>
        <Show when={props.delta}>
          {(d) => (
            <span class="ui-kpi__delta ui-tnum" data-tone={deltaTone(d())} data-direction={d().direction}>
              <Icon icon={ARROWS[d().direction]} size={12} />
              <span aria-hidden="true">{d().value}</span>
              <span class="ui-sr-only">{spoken(d())}</span>
            </span>
          )}
        </Show>
      </div>
      <Show when={props.hint !== undefined}>
        <div class="ui-kpi__hint">{props.hint}</div>
      </Show>
      <Show when={props.sparkline !== undefined}>
        <div class="ui-kpi__spark">{props.sparkline}</div>
      </Show>
    </div>
  );
}
