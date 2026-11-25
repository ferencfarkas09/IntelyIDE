import { Show, type JSX } from "solid-js";

export interface ChoiceCardProps {
  /** `checkbox`: a tick card (several may be on); `radio`: one of a named group; `switch`: a setting row with the box at the end. */
  type: "checkbox" | "radio" | "switch";
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: JSX.Element;
  /** One quiet line under the title. */
  description?: JSX.Element;
  /** Draws the description in the mono face on one line (a branch, a path). */
  mono?: boolean;
  /** Radio group name. */
  name?: string;
  value?: string;
  disabled?: boolean;
  /** Extra content at the end of the card (a badge, a link). */
  end?: JSX.Element;
  tooltip?: string;
  class?: string;
  "data-testid"?: string;
}

/**
 * A bordered card around a native tick box, radio or switch: the whole card is the label, the chosen one carries the accent
 * tint. The native input keeps the keyboard behaviour (arrow keys inside a radio group, Space to tick).
 */
export function ChoiceCard(props: ChoiceCardProps) {
  const input = (
    <input
      class="ui-choice__input"
      type={props.type === "radio" ? "radio" : "checkbox"}
      role={props.type === "switch" ? "switch" : undefined}
      name={props.name}
      value={props.value ?? "on"}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.checked)}
      // Enter ticks a card too (a native tick box only answers Space); a radio is chosen with the arrow keys as usual.
      onKeyDown={(e) => {
        if (e.key !== "Enter" || props.type === "radio" || props.disabled || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        props.onChange(!props.checked);
      }}
    />
  );
  return (
    <label
      class={props.class ? `ui-choice ${props.class}` : "ui-choice"}
      data-checked={props.checked ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      data-align={props.type === "radio" ? undefined : "center"}
      title={props.tooltip}
      data-testid={props["data-testid"]}
    >
      <Show when={props.type !== "switch"}>{input}</Show>
      <span class="ui-choice__body">
        <span class="ui-choice__title">{props.title}</span>
        <Show when={props.description !== undefined}>
          <span class="ui-choice__desc" data-mono={props.mono ? "" : undefined}>{props.description}</span>
        </Show>
      </span>
      <Show when={props.end !== undefined}>
        <span class="ui-choice__end">{props.end}</span>
      </Show>
      <Show when={props.type === "switch"}>{input}</Show>
    </label>
  );
}
