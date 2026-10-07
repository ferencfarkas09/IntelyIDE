export interface SpinnerProps {
  size?: 12 | 14 | 16 | 20 | 24;
  /** Announced to assistive tech; omit when the spinner sits next to visible text. */
  label?: string;
  class?: string;
}

export function Spinner(props: SpinnerProps) {
  return (
    <svg
      class={props.class ? `ui-spinner ${props.class}` : "ui-spinner"}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      role={props.label ? "status" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <circle class="ui-spinner__track" cx="12" cy="12" r="9" stroke-width="2.5" />
      <circle class="ui-spinner__arc" cx="12" cy="12" r="9" stroke-width="2.5" stroke-linecap="round" pathLength="100" stroke-dasharray="28 100" />
    </svg>
  );
}
