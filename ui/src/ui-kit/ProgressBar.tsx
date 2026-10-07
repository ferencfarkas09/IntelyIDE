export interface ProgressBarProps {
  /** 0-100. Omit for indeterminate. */
  value?: number;
  tone?: "accent" | "ok" | "warn" | "danger";
  size?: "sm" | "md";
  "aria-label": string;
  class?: string;
}

export function ProgressBar(props: ProgressBarProps) {
  const pct = () => (props.value === undefined ? undefined : Math.max(0, Math.min(100, props.value)));
  return (
    <div
      class={props.class ? `ui-progress ${props.class}` : "ui-progress"}
      role="progressbar"
      aria-label={props["aria-label"]}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct() === undefined ? undefined : Math.round(pct()!)}
      data-tone={props.tone ?? "accent"}
      data-size={props.size ?? "md"}
      data-indeterminate={pct() === undefined ? "" : undefined}
    >
      <div class="ui-progress__fill" style={{ width: pct() === undefined ? undefined : `${pct()}%` }} />
    </div>
  );
}
