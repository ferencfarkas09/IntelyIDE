import { splitProps, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, Input, toast, type InputProps } from "../../ui-kit";
import { asEngineError, errorText } from "./errors";
import { openPathPicker } from "./store";

/** The Browse button alone, for forms that own their text field. Fills with the canonical path of the chosen file. */
export function BrowseButton(props: { purpose: `file:${string}`; extensions?: string[]; label: string; onPath(path: string): void; disabled?: boolean }) {
  async function browse(): Promise<void> {
    try {
      const picked = await openPathPicker({ kind: "file", purpose: props.purpose, extensions: props.extensions, title: t("picker.file.browseFor", { field: props.label }) });
      if (picked?.[0]) props.onPath(picked[0].path);
    } catch (e) {
      toast.show({ tone: "danger", title: errorText(asEngineError(e)) });
    }
  }
  return (
    <Button size="sm" variant="ghost" disabled={props.disabled} aria-label={t("picker.file.browseFor", { field: props.label })} onClick={() => void browse()}>
      {t("picker.file.browse")}
    </Button>
  );
}

export interface PathFieldProps extends Omit<InputProps, "value" | "onInput" | "onChange" | "trailing"> {
  value: string;
  onInput(value: string): void;
  purpose: `file:${string}`;
  /** Extensions offered in the browser (without the dot). */
  extensions?: string[];
  /** What the field is for, in the user's language: "Browse for {field}". */
  label: string;
  clearable?: boolean;
}

/** A path text field with a Browse button. Typing still works; Browse fills the field with the canonical path. */
export function PathField(props: PathFieldProps) {
  const [own, rest] = splitProps(props, ["value", "onInput", "purpose", "extensions", "label", "clearable"]);

  async function browse(): Promise<void> {
    try {
      const picked = await openPathPicker({ kind: "file", purpose: own.purpose, extensions: own.extensions, title: t("picker.file.browseFor", { field: own.label }) });
      if (picked?.[0]) own.onInput(picked[0].path);
    } catch (e) {
      toast.show({ tone: "danger", title: errorText(asEngineError(e)) });
    }
  }

  return (
    <div class="pp-field">
      <Input {...rest} value={own.value} onInput={(e) => own.onInput(e.currentTarget.value)} />
      <Button size={rest.size === "lg" ? "lg" : "md"} aria-label={t("picker.file.browseFor", { field: own.label })} onClick={() => void browse()}>
        {t("picker.file.browse")}
      </Button>
      <Show when={own.clearable && own.value}>
        <Button size="md" variant="ghost" onClick={() => own.onInput("")}>
          {t("picker.file.clear")}
        </Button>
      </Show>
    </div>
  );
}
