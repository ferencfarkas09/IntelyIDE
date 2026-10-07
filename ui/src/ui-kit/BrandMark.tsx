import { createUniqueId, For, Show, type JSX } from "solid-js";
import { LOCKUPS, MARK, MARK_SMALL, type MarkData } from "./brandGeometry";
import { Tooltip } from "./Tooltip";
import "./brand.css";

export type BrandVariant = "mark" | "small" | "lockup" | "stacked";

export interface BrandMarkProps {
  /** `mark` is the full logo, `small` the simplified 16 / 32 px cut, `lockup` and `stacked` add the wordmark. Default: `small` up to 32 px, otherwise `mark`. */
  variant?: BrandVariant;
  /** Height in px; the mark variants are square. Default 16. */
  size?: number;
  /** Pin the ink palette instead of following the app theme (for a dark tile inside the light theme). */
  theme?: "dark" | "light";
  /** Draw the mark on the dark app-icon tile (splash, About). Marks only. */
  tile?: boolean;
  /** Drop shadow under the bars. Default: from 48 px up. */
  shadow?: boolean;
  /** Accessible name; the logo is decorative when omitted. */
  label?: string;
  class?: string;
}

/** Bars, cursor and spark of the mark in its own units; gradient ids carry `id` so several instances never clash. */
function MarkShapes(props: { data: MarkData; id: string; shadow: boolean }) {
  const inner = () => (
    <>
      <For each={props.data.bars}>
        {(b) => <path d={b.d} fill="none" stroke={`url(#${props.id}-${b.y})`} stroke-width={props.data.barWidth} stroke-linecap="round" />}
      </For>
      <path class="brand__ink-stroke" d={props.data.cursor.d} fill="none" stroke-width={props.data.cursor.width} stroke-linecap="round" />
    </>
  );
  return (
    <>
      <defs>
        <For each={props.data.bars}>
          {(b) => (
            <linearGradient id={`${props.id}-${b.y}`} gradientUnits="userSpaceOnUse" x1={b.x1} y1={b.y} x2={b.x2} y2={b.y}>
              <stop offset="0" stop-color={b.from} />
              <stop offset="1" stop-color={b.to} />
            </linearGradient>
          )}
        </For>
        <Show when={props.shadow}>
          <filter id={`${props.id}-sh`} x="-20%" y="-30%" width="140%" height="160%">
            <feDropShadow class="brand__shadow" dx="0" dy="5" stdDeviation="5" />
          </filter>
        </Show>
      </defs>
      <Show when={props.shadow} fallback={inner()}>
        <g filter={`url(#${props.id}-sh)`}>{inner()}</g>
      </Show>
      <Show when={props.data.spark}>{(s) => <path class="brand__ink" d={s().d} transform={s().transform} />}</Show>
    </>
  );
}

/** The IntelyIDE (B2) logo. Colours come from the --brand-* tokens, so the ink flips with the theme. */
export function BrandMark(props: BrandMarkProps) {
  const id = `bm${createUniqueId()}`;
  const size = () => props.size ?? 16;
  const variant = (): BrandVariant => props.variant ?? (size() <= 32 ? "small" : "mark");
  const shadow = () => props.shadow ?? (size() >= 48 && variant() !== "small");
  const a11y = () => (props.label ? { role: "img" as const, "aria-label": props.label } : { "aria-hidden": true as const });
  const cls = () => (props.class ? `brand ${props.class}` : "brand");

  const mark = () => (
    <svg class={cls()} data-brand-theme={props.theme} data-variant={variant()} width={size()} height={size()} viewBox={(variant() === "small" ? MARK_SMALL : MARK).viewBox.join(" ")} {...a11y()}>
      <MarkShapes data={variant() === "small" ? MARK_SMALL : MARK} id={id} shadow={shadow()} />
    </svg>
  );

  const lockup = () => {
    const l = LOCKUPS[variant() === "stacked" ? "stacked" : "horizontal"];
    const [x, y, w, h] = l.viewBox;
    return (
      <svg class={cls()} data-brand-theme={props.theme} data-variant={variant()} width={(size() * w) / h} height={size()} viewBox={`${x} ${y} ${w} ${h}`} {...a11y()}>
        <defs>
          <linearGradient id={`${id}-ide`} gradientUnits="userSpaceOnUse" x1={l.ideX[0]} y1="0" x2={l.ideX[1]} y2="0">
            <stop class="brand__ide-a" offset="0" />
            <stop class="brand__ide-b" offset="1" />
          </linearGradient>
        </defs>
        <g transform={`translate(${l.mark.tx} ${l.mark.ty}) scale(${l.mark.scale})`}>
          <MarkShapes data={MARK} id={id} shadow={props.shadow ?? true} />
        </g>
        <path class="brand__ink" d={l.intely} />
        <path d={l.ide} fill={`url(#${id}-ide)`} />
        <path class="brand__sub" d={l.sub} />
      </svg>
    );
  };

  const isLockup = () => variant() === "lockup" || variant() === "stacked";
  return (
    <Show when={props.tile && !isLockup()} fallback={isLockup() ? lockup() : mark()}>
      <span class="brand-tile" data-brand-theme="dark" style={{ "--tile": `${size()}px` }}>
        <BrandMark variant={size() <= 32 ? "small" : "mark"} size={Math.round(size() * (size() <= 32 ? 0.78 : 0.722))} theme="dark" shadow={shadow()} label={props.label} />
      </span>
    </Show>
  );
}

export interface BrandButtonProps {
  /** Accessible name and tooltip. */
  label: string;
  onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  /** Mark size in px. Default 20. */
  size?: number;
}

/** The logo as a ghost icon button (title bar). Reuses the IconButton chrome. */
export function BrandButton(props: BrandButtonProps) {
  return (
    <Tooltip label={props.label}>
      <button type="button" class="ui-icon-btn" data-variant="ghost" data-size="sm" aria-label={props.label} onClick={props.onClick}>
        <BrandMark size={props.size ?? 20} />
      </button>
    </Tooltip>
  );
}
