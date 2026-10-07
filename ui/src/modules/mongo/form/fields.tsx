import { createSignal, For, Show, type JSX } from "solid-js";
import { t, type MessageKey } from "../../../i18n";
import { Checkbox, Eye, EyeOff, IconButton, Input, Lock, Select, type SelectOption } from "../../../ui-kit";
import { BrowseButton } from "../../../platform/pathpicker";
import { useForm } from "./controller";
import { fieldId, type Problem, type SecretSlot } from "./model";

/** Problems of an empty, untouched form are held back until the first Save or Test; the rest show as the user types. */
const DEFERRED = new Set(["name.required", "host.required", "hosts.required", "ssh.hostRequired", "proxy.hostRequired", "ssh.keyFileRequired", "ssh.user", "ssh.host", "proxy.host", "x509.needsCert"]);

export const problemText = (p: Pick<Problem, "code">): string => t(`mongoForm.problem.${p.code}` as MessageKey);

/** The problems of one field (exact path), as the form wants to show them now. */
export function useProblems(path: () => string | undefined) {
  const f = useForm();
  return () => {
    const p = path();
    if (!p) return [] as Problem[];
    return f.problems().filter((x) => x.path === p && (f.showErrors() || !DEFERRED.has(x.code)));
  };
}

export interface FieldProps {
  /** The state path; names the element id and links the problems. */
  path?: string;
  label: string;
  hint?: JSX.Element;
  children: (a: { id: string; invalid: boolean; describedBy: string | undefined }) => JSX.Element;
  class?: string;
}

/** A label above one control, an optional hint, and the field's problems linked with `aria-describedby`. */
export function Field(props: FieldProps) {
  const problems = useProblems(() => props.path);
  const id = () => (props.path ? fieldId(props.path) : `mgf-${Math.random().toString(36).slice(2, 8)}`);
  const stable = id();
  const hintId = `${stable}-hint`;
  const errId = `${stable}-err`;
  const invalid = () => problems().some((p) => !p.warning);
  const describedBy = () => [props.hint ? hintId : "", problems().length ? errId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div class={props.class ? `mgf-field ${props.class}` : "mgf-field"}>
      <label class="mgf-field__label" for={stable}>{props.label}</label>
      {props.children({ id: stable, invalid: invalid(), describedBy: describedBy() })}
      <Show when={props.hint}><p class="mgf-field__hint" id={hintId}>{props.hint}</p></Show>
      <Show when={problems().length}>
        <ul class="mgf-field__errs" id={errId}>
          <For each={problems()}>{(p) => <li data-warning={p.warning ? "" : undefined}>{problemText(p)}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}

export interface TextFieldProps {
  path?: string;
  label: string;
  hint?: JSX.Element;
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  /** Host names, paths and options are code: monospace and always left-to-right. */
  code?: boolean;
  disabled?: boolean;
  inputmode?: JSX.HTMLAttributes<HTMLInputElement>["inputmode"];
  trailing?: JSX.Element;
  onPaste?: (e: ClipboardEvent) => void;
  autofocus?: boolean;
  /** A file field: adds a Browse button that fills the text with the chosen file's canonical path. */
  browse?: { purpose: `file:${string}`; extensions?: string[] };
}

export function TextField(props: TextFieldProps) {
  return (
    <Field path={props.path} label={props.label} hint={props.hint}>
      {(a) => (
        <Input
          id={a.id}
          aria-describedby={a.describedBy}
          invalid={a.invalid}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          placeholder={props.placeholder}
          disabled={props.disabled}
          inputmode={props.inputmode}
          trailing={props.trailing ?? (props.browse ? <BrowseButton purpose={props.browse.purpose} extensions={props.browse.extensions} label={props.label} disabled={props.disabled} onPath={props.onInput} /> : undefined)}
          onPaste={props.onPaste}
          data-autofocus={props.autofocus ? "" : undefined}
          class={props.code ? "mgf-code" : undefined}
          dir={props.code ? "ltr" : undefined}
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
        />
      )}
    </Field>
  );
}

export interface SelectFieldProps<T extends string> {
  path?: string;
  label: string;
  hint?: JSX.Element;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
}
export function SelectField<T extends string>(props: SelectFieldProps<T>) {
  return (
    <Field path={props.path} label={props.label} hint={props.hint}>
      {(a) => <Select id={a.id} aria-label={props.label} aria-describedby={a.describedBy} invalid={a.invalid} value={props.value} options={props.options} onChange={props.onChange} disabled={props.disabled} />}
    </Field>
  );
}

export interface SecretFieldProps {
  slot: SecretSlot;
  path: string;
  label: string;
  /** "Save in the Keychain" checkbox state; undefined hides the checkbox (nothing to remember). */
  save?: boolean;
  onSave?: (v: boolean) => void;
  /** The line that names where this secret will be sent. */
  destination?: JSX.Element;
}

/**
 * A write-only secret: never shown after typing, no autofill, a reveal toggle for the typed text, and the destination it will be
 * sent to next to it. Saved or pasted secrets show a state chip with Forget; the value itself is not available to the page.
 */
export function SecretField(props: SecretFieldProps) {
  const f = useForm();
  const [reveal, setReveal] = createSignal(false);
  const state = () => f.secretState(props.slot);
  const canSave = () => f.keychain();
  const savedHere = () => state() === "saved" || state() === "pasted";
  return (
    <Field path={props.path} label={props.label}>
      {(a) => (
        <>
          <Input
            id={a.id}
            type={reveal() ? "text" : "password"}
            autocomplete="new-password"
            spellcheck={false}
            autocapitalize="off"
            aria-describedby={[a.describedBy, `${a.id}-dest`].filter(Boolean).join(" ")}
            value={f.secrets[props.slot]}
            placeholder={savedHere() ? t("mongoForm.secret.keepPlaceholder") : undefined}
            onInput={(e) => f.typeSecret(props.slot, e.currentTarget.value)}
            trailing={<IconButton icon={reveal() ? EyeOff : Eye} label={reveal() ? t("mongoForm.secret.hide") : t("mongoForm.secret.show")} aria-pressed={reveal()} size="sm" onClick={() => setReveal(!reveal())} />}
          />
          <div class="mgf-secret__row">
            <Show when={state() !== "none" && state() !== "typed"}>
              <span class="mgf-chip" data-tone="ok"><Lock size={12} aria-hidden="true" /> {state() === "pasted" ? t("mongoForm.secret.pasted") : t("mongoForm.secret.saved")}</span>
              <button type="button" class="mgf-link" onClick={() => f.clearSecret(props.slot)}>{t("mongoForm.secret.forget")}</button>
            </Show>
            <Show when={props.onSave}>
              <Checkbox
                size="sm"
                checked={canSave() && !!props.save}
                disabled={!canSave()}
                onChange={(v) => props.onSave?.(v)}
                label={t("mongoForm.secret.saveKeychain")}
              />
            </Show>
          </div>
          <Show when={props.onSave && !canSave() && f.secretStatus()}>
            <p class="mgf-field__hint" role="status">{f.secretStatus()?.store === "session" ? t("mongoForm.secret.sessionOnly") : t("mongoForm.secret.unavailable")}</p>
          </Show>
          <Show when={props.onSave && canSave() && !props.save}>
            <p class="mgf-field__hint">{t("mongoForm.secret.askEachTime")}</p>
          </Show>
          <Show when={props.destination}><p class="mgf-dest" id={`${a.id}-dest`}>{props.destination}</p></Show>
        </>
      )}
    </Field>
  );
}

/** A small star toggle for favourites. */
export function StarToggle(props: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" class="mgf-star" aria-pressed={props.on} aria-label={props.label} title={props.label} onClick={() => props.onChange(!props.on)}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill={props.on ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linejoin="round">
        <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z" />
      </svg>
    </button>
  );
}
