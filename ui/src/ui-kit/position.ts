export type Side = "top" | "bottom" | "left" | "right";
export type Placement = Side | `${Side}-start` | `${Side}-end`;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PositionResult {
  x: number;
  y: number;
  placement: Placement;
}

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

function split(p: Placement): [Side, "start" | "center" | "end"] {
  const [side, align] = p.split("-") as [Side, "start" | "end" | undefined];
  return [side, align ?? "center"];
}

function place(anchor: Box, float: Pick<Box, "width" | "height">, side: Side, align: "start" | "center" | "end", gap: number) {
  const horizontal = side === "top" || side === "bottom";
  let x: number;
  let y: number;
  if (horizontal) {
    y = side === "top" ? anchor.top - float.height - gap : anchor.top + anchor.height + gap;
    x = align === "start" ? anchor.left : align === "end" ? anchor.left + anchor.width - float.width : anchor.left + (anchor.width - float.width) / 2;
  } else {
    x = side === "left" ? anchor.left - float.width - gap : anchor.left + anchor.width + gap;
    y = align === "start" ? anchor.top : align === "end" ? anchor.top + anchor.height - float.height : anchor.top + (anchor.height - float.height) / 2;
  }
  return { x, y };
}

/** Viewport-aware placement: flips to the opposite side when the preferred one overflows, then clamps. */
export function computePosition(
  anchor: Box,
  float: Pick<Box, "width" | "height">,
  placement: Placement,
  gap: number,
  viewport: Pick<Box, "width" | "height">,
  pad = 8,
): PositionResult {
  const [side, align] = split(placement);
  const fits = (s: Side) => {
    const { x, y } = place(anchor, float, s, align, gap);
    return s === "top" || s === "bottom"
      ? y >= pad && y + float.height <= viewport.height - pad
      : x >= pad && x + float.width <= viewport.width - pad;
  };
  const finalSide = fits(side) || !fits(OPPOSITE[side]) ? side : OPPOSITE[side];
  const pos = place(anchor, float, finalSide, align, gap);
  return {
    x: Math.round(Math.max(pad, Math.min(pos.x, viewport.width - float.width - pad))),
    y: Math.round(Math.max(pad, Math.min(pos.y, viewport.height - float.height - pad))),
    placement: (align === "center" ? finalSide : `${finalSide}-${align}`) as Placement,
  };
}
