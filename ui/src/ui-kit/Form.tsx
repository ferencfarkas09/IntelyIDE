import { Show, type JSX } from "solid-js";

export interface FormGroupProps {
  title?: string;
  description?: string;
  children: JSX.Element;
  class?: string;
}

/** A titled block of settings rows; the rows share one hairline-divided card. */
export function FormGroup(props: FormGroupProps) {
  return (
    <section class={props.class ? `ui-formgroup ${props.class}` : "ui-formgroup"}>
      <Show when={props.title}>
        <header class="ui-formgroup__head">
          <h4 class="ui-formgroup__title">{props.title}</h4>
          <Show when={props.description}>
            <p class="ui-formgroup__desc">{props.description}</p>
          </Show>
        </header>
      </Show>
      <div class="ui-formgroup__rows">{props.children}</div>
    </section>
  );
}

export interface FormRowProps {
  label: string;
  /** One quiet sentence under the label. */
  description?: JSX.Element;
  /** `for` target of the label when the control is a single input. */
  labelFor?: string;
  /** Stack the control under the label instead of beside it (wide controls such as lists). */
  stacked?: boolean;
  children?: JSX.Element;
  class?: string;
}

/** Label and hint on the left, the control on the right. */
export function FormRow(props: FormRowProps) {
  return (
    <div class={props.class ? `ui-formrow ${props.class}` : "ui-formrow"} data-stacked={props.stacked ? "" : undefined}>
      <div class="ui-formrow__text">
        <Show when={props.labelFor} fallback={<span class="ui-formrow__label">{props.label}</span>}>
          <label class="ui-formrow__label" for={props.labelFor}>
            {props.label}
          </label>
        </Show>
        <Show when={props.description}>
          <p class="ui-formrow__desc">{props.description}</p>
        </Show>
      </div>
      <div class="ui-formrow__control">{props.children}</div>
    </div>
  );
}
