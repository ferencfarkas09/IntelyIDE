import { createUniqueId, Show } from "solid-js";
import { t } from "../i18n";

export type SparkTone = "accent" | "ok" | "warn" | "danger" | "info" | "neutral";

export interface SparklineProps {
  values: readonly number[];
  /** Drawing size in px; the SVG scales to its box, the stroke stays crisp. */
  width?: number;
  height?: number;
  /** A soft fill under the line (default on). */
  area?: boolean;
  tone?: SparkTone;
  /** Accessible name. Default: "Trend: <first> to <last>" with `format`. */
  title?: string;
  format?: (n: number) => string;
  class?: string;
}

export interface SparkGeometry {
  /** `x,y` pairs for an SVG polyline. */
  line: string;
  /** Closed polygon down to the baseline, for the area fill. */
  area: string;
  last: { x: number; y: number } | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Maps values onto a `width` x `height` box with `pad` px kept free at the top and bottom (for the stroke and the end dot).
 * Non-finite values are skipped; one value or a flat series draws a level line in the middle.
 */
export function sparkGeometry(values: readonly number[], width: number, height: number, pad = 2): SparkGeometry {
  const v = values.filter((n) => Number.isFinite(n));
  if (!v.length) return { line: "", area: "", last: null };
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min;
  const step = v.length > 1 ? width / (v.length - 1) : 0;
  const y = (n: number) => (span === 0 ? height / 2 : pad + (1 - (n - min) / span) * (height - 2 * pad));
  const pts = v.map((n, i) => ({ x: round(v.length > 1 ? i * step : width / 2), y: round(y(n)) }));
  if (pts.length === 1) pts.unshift({ x: 0, y: pts[0].y }), pts.push({ x: width, y: pts[1].y });
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const area = `0,${height} ${line} ${round(pts[pts.length - 1].x)},${height}`;
  return { line, area, last: v.length > 1 ? pts[pts.length - 1] : pts[1] };
}

/** A small trend line from tokens only (no chart library). Decorative detail goes in `title`, which names the image. */
export function Sparkline(props: SparklineProps) {
  const id = createUniqueId();
  const w = () => props.width ?? 120;
  const h = () => props.height ?? 32;
  const geo = () => sparkGeometry(props.values, w(), h());
  const name = () => {
    if (props.title) return props.title;
    const v = props.values.filter((n) => Number.isFinite(n));
    if (!v.length) return "";
    const f = props.format ?? ((n: number) => String(n));
    return t("kit.sparklineTrend", { from: f(v[0]), to: f(v[v.length - 1]) });
  };
  return (
    <svg
      class={props.class ? `ui-spark ${props.class}` : "ui-spark"}
      data-tone={props.tone ?? "accent"}
      viewBox={`0 0 ${w()} ${h()}`}
      width={w()}
      height={h()}
      preserveAspectRatio="none"
      role="img"
      aria-label={name()}
    >
      <title>{name()}</title>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="currentColor" stop-opacity="0.28" />
          <stop offset="1" stop-color="currentColor" stop-opacity="0" />
        </linearGradient>
      </defs>
      <Show when={props.area !== false && geo().area}>
        <polygon class="ui-spark__area" points={geo().area} fill={`url(#${id}-fill)`} />
      </Show>
      <polyline class="ui-spark__line" points={geo().line} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
  );
}
