import { createUniqueId, Show, type JSX } from "solid-js";

export interface CardProps {
  /** Heading of the card; it also names the region for screen readers. */
  title?: JSX.Element;
  subtitle?: JSX.Element;
  /** Small controls at the end of the header (an IconButton, a SegmentedControl). */
  actions?: JSX.Element;
  padding?: "none" | "sm" | "md";
  /** Names the region when there is no visible title. */
  "aria-label"?: string;
  class?: string;
  children?: JSX.Element;
}

/** Rounded surface for grouped content (dashboards, summaries). With the Glass skin it is a translucent sheet with a soft shadow. */
export function Card(props: CardProps) {
  const id = createUniqueId();
  return (
    <section
      class={props.class ? `ui-card ${props.class}` : "ui-card"}
      data-padding={props.padding ?? "md"}
      aria-labelledby={props.title !== undefined ? `${id}-title` : undefined}
      aria-label={props.title === undefined ? props["aria-label"] : undefined}
    >
      <Show when={props.title !== undefined || props.actions !== undefined}>
        <header class="ui-card__head">
          <div class="ui-card__titles">
            <Show when={props.title !== undefined}>
              <h3 class="ui-card__title" id={`${id}-title`}>{props.title}</h3>
            </Show>
            <Show when={props.subtitle !== undefined}>
              <p class="ui-card__subtitle">{props.subtitle}</p>
            </Show>
          </div>
          <Show when={props.actions !== undefined}>
            <div class="ui-card__actions">{props.actions}</div>
          </Show>
        </header>
      </Show>
      {props.children}
    </section>
  );
}
