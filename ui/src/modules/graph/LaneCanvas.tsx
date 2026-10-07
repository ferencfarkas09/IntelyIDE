import { createEffect, onCleanup } from "solid-js";
import { resolvedTheme } from "../../ui-kit";
import { laneColor, type LaneEdge, type LaneRow } from "./lanes";

export const ROW_H = 26;
export const LANE_W = 14;
const NODE_R = 4;

export const laneX = (lane: number): number => lane * LANE_W + LANE_W / 2;

function drawEdge(ctx: CanvasRenderingContext2D, edge: LaneEdge, fromY: number, toY: number): void {
  ctx.strokeStyle = laneColor(edge.color);
  ctx.beginPath();
  ctx.moveTo(laneX(edge.from), fromY);
  if (edge.from === edge.to) ctx.lineTo(laneX(edge.to), toY);
  else ctx.bezierCurveTo(laneX(edge.from), (fromY + toY) / 2, laneX(edge.to), (fromY + toY) / 2, laneX(edge.to), toY);
  ctx.stroke();
}

/** Draws rows `first..last` of the lane layout on one canvas; the canvas covers only the window that is on screen. */
export function drawLanes(ctx: CanvasRenderingContext2D, rows: readonly LaneRow[], first: number, last: number, surface: string): void {
  ctx.lineWidth = 1.75;
  ctx.lineCap = "round";
  for (let i = first; i < last; i++) {
    const row = rows[i];
    const y0 = (i - first) * ROW_H;
    const mid = y0 + ROW_H / 2;
    // Overdraw by a pixel so adjacent rows join without seams.
    for (const e of row.top) drawEdge(ctx, e, y0 - 0.5, mid);
    for (const e of row.bottom) drawEdge(ctx, e, mid, y0 + ROW_H + 0.5);
    ctx.beginPath();
    ctx.arc(laneX(row.col), mid, NODE_R, 0, Math.PI * 2);
    ctx.fillStyle = row.merge ? surface : laneColor(row.color);
    ctx.fill();
    if (row.merge) {
      ctx.strokeStyle = laneColor(row.color);
      ctx.stroke();
    }
  }
}

export interface LaneCanvasProps {
  rows: readonly LaneRow[];
  first: number;
  last: number;
  width: number;
}

export function LaneCanvas(props: LaneCanvasProps) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    resolvedTheme();
    const { rows, first, last, width } = props;
    const height = Math.max(0, last - first) * ROW_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLanes(ctx, rows, first, last, getComputedStyle(canvas).getPropertyValue("--surface-1").trim() || "#fff");
  });
  onCleanup(() => canvas.getContext?.("2d")?.clearRect(0, 0, canvas.width, canvas.height));
  return (
    <canvas
      ref={canvas}
      class="glog__canvas"
      aria-hidden="true"
      style={{ top: `${props.first * ROW_H}px`, width: `${props.width}px`, height: `${Math.max(0, props.last - props.first) * ROW_H}px` }}
    />
  );
}
