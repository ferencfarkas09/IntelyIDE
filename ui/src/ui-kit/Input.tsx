import { createEffect, onMount, Show, splitProps, type JSX } from "solid-js";

export interface InputProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
  /** Icon or text before the field. */
  leading?: JSX.Element;
  trailing?: JSX.Element;
  wrapperClass?: string;
}

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ["size", "invalid", "leading", "trailing", "class", "wrapperClass"]);
  return (
    <div class={local.wrapperClass ? `ui-input ${local.wrapperClass}` : "ui-input"} data-size={local.size ?? "md"} data-invalid={local.invalid ? "" : undefined} data-disabled={props.disabled ? "" : undefined}>
      <Show when={local.leading}>
        <span class="ui-input__adorn">{local.leading}</span>
      </Show>
      <input {...rest} class={local.class ? `ui-input__field ${local.class}` : "ui-input__field"} aria-invalid={local.invalid ? "true" : undefined} />
      <Show when={local.trailing}>
        <span class="ui-input__adorn">{local.trailing}</span>
      </Show>
    </div>
  );
}

export interface TextAreaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minRows?: number;
  maxRows?: number;
  invalid?: boolean;
  wrapperClass?: string;
}

/** Grows with its content between minRows and maxRows, then scrolls. */
export function TextArea(props: TextAreaProps) {
  const [local, rest] = splitProps(props, ["minRows", "maxRows", "invalid", "class", "wrapperClass", "ref", "onInput", "value"]);
  let el!: HTMLTextAreaElement;
  const fit = () => {
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 18;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const min = (local.minRows ?? 2) * line + pad;
    const max = (local.maxRows ?? 10) * line + pad;
    el.style.height = "auto";
    const h = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  };
  onMount(() => {
    fit();
    // Web fonts change line metrics after first layout.
    document.fonts?.ready.then(fit);
  });
  createEffect(() => {
    local.value;
    local.minRows;
    local.maxRows;
    fit();
  });
  return (
    <div class={local.wrapperClass ? `ui-input ${local.wrapperClass}` : "ui-input"} data-multiline="" data-invalid={local.invalid ? "" : undefined} data-disabled={props.disabled ? "" : undefined}>
      <textarea
        {...rest}
        ref={(n) => {
          el = n;
          (local.ref as ((e: HTMLTextAreaElement) => void) | undefined)?.(n);
        }}
        class={local.class ? `ui-input__field ${local.class}` : "ui-input__field"}
        value={local.value}
        aria-invalid={local.invalid ? "true" : undefined}
        onInput={(e) => {
          fit();
          const h = local.onInput;
          if (typeof h === "function") h(e);
          else if (h) h[0](h[1], e);
        }}
      />
    </div>
  );
}
