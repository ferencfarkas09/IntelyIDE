export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  variant?: "text" | "rect" | "circle";
  class?: string;
}

const px = (v: number | string | undefined) => (typeof v === "number" ? `${v}px` : v);

/** Placeholder block with a slow shimmer (static under reduced motion). */
export function Skeleton(props: SkeletonProps) {
  return (
    <span
      class={props.class ? `ui-skeleton ${props.class}` : "ui-skeleton"}
      data-variant={props.variant ?? "rect"}
      style={{ width: px(props.width), height: px(props.height) }}
      aria-hidden="true"
    />
  );
}
