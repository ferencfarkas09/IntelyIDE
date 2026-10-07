import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, Copy, Eye, EyeOff, IconButton, Input, Spinner, toast, TriangleAlert } from "../../ui-kit";
import { useForm } from "./form/controller";
import { looksLikeUri } from "./form/model";
import { noteText } from "./form/tabsMore";

export interface UriFieldProps {
  /** The pasted text. It lives here only until Rust has parsed it; then it is cleared. */
  value: string;
  onValue: (v: string) => void;
  /** Parse and fill the form (Rust). */
  onApply: (text: string) => void;
  busy?: boolean;
  /** "scheme" = the text is not a MongoDB string; anything else is Rust's message. */
  error?: string;
  /** The masked rendering of the current fields (`user:***@`). */
  masked: string;
}

/**
 * The "Connection string" mode. A string is pasted once, parsed in Rust, turned into fields, and the pasted text is cleared and
 * replaced by the masked rendering. While typed it is hidden like a password (Show toggles it for a paste check); there is no
 * way to read a password back.
 */
export function UriField(props: UriFieldProps) {
  const [reveal, setReveal] = createSignal(false);
  const copy = () => void navigator.clipboard?.writeText(props.masked).then(() => toast.info(t("mongoForm.copied")));
  const apply = () => props.onApply(props.value);
  return (
    <div class="mgf-uri">
      <label class="mgf-field__label" for="mgf-uri-input">{t("mongoForm.uri.label")}</label>
      <Input
        id="mgf-uri-input"
        type={reveal() ? "text" : "password"}
        placeholder="mongodb+srv://user:password@cluster0.example.mongodb.net/"
        autocomplete="off"
        spellcheck={false}
        autocapitalize="off"
        dir="ltr"
        class="mgf-code"
        value={props.value}
        invalid={!!props.error}
        aria-describedby="mgf-uri-hint mgf-uri-err"
        onInput={(e) => props.onValue(e.currentTarget.value)}
        onPaste={(e) => {
          const text = e.clipboardData?.getData("text") ?? "";
          if (!looksLikeUri(text)) return;
          e.preventDefault();
          props.onApply(text);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), apply())}
        trailing={<IconButton icon={reveal() ? EyeOff : Eye} label={reveal() ? t("mongoForm.uri.hide") : t("mongoForm.uri.show")} aria-pressed={reveal()} size="sm" onClick={() => setReveal(!reveal())} />}
      />
      <div class="mgf-row">
        <Button size="sm" variant="secondary" disabled={!props.value.trim() || props.busy} loading={props.busy} onClick={apply}>{t("mongoForm.uri.fill")}</Button>
        <Show when={props.busy}><Spinner size={14} /></Show>
      </div>
      <p class="mgf-field__hint" id="mgf-uri-hint">{t("mongoForm.uri.hint")}</p>
      <p class="mgf-field__errs" id="mgf-uri-err" role="alert">
        <Show when={props.error}>{props.error === "scheme" ? t("mongoForm.uri.badScheme") : props.error}</Show>
      </p>
      <Show when={props.masked}>
        <div class="mgf-masked">
          <span class="mgf-field__label">{t("mongoForm.uri.masked")}</span>
          <code class="mgf-masked__value" dir="ltr" aria-label={t("mongoForm.uri.maskedAria")}>{props.masked}</code>
          <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>{t("mongoForm.uri.copy")}</Button>
        </div>
      </Show>
    </div>
  );
}

/** The parse notes of a pasted string: what was ignored, what is not supported, and why. Read-only options are collapsed. */
function ParseNotes() {
  const f = useForm();
  const n = () => f.notes();
  const any = () => n().warnings.length + n().unsupported.length + n().info.length > 0;
  return (
    <Show when={any()}>
      <div class="mgf-notes" role="status">
        <Show when={n().unsupported.length + n().warnings.length}>
          <p class="mgf-notes__title"><TriangleAlert size={14} aria-hidden="true" /> {t("mongoForm.uri.notes", { count: n().unsupported.length + n().warnings.length })}</p>
          <ul>
            <For each={[...n().unsupported, ...n().warnings]}>{(x) => <li><code dir="ltr">{x.option ?? ""}</code> {noteText(x.code)}</li>}</For>
          </ul>
        </Show>
        <Show when={n().info.length}>
          <details>
            <summary>{t("mongoForm.uri.infoNotes", { count: n().info.length })}</summary>
            <ul>
              <For each={n().info}>{(x) => <li><code dir="ltr">{x.option ?? ""}</code> {noteText(x.code)}</li>}</For>
            </ul>
          </details>
        </Show>
      </div>
    </Show>
  );
}

/** The string mode of the Connection tab, wired to the form. */
export function UriPanel() {
  const f = useForm();
  return (
    <div class="mgf-stack">
      <UriField value={f.pasted()} onValue={f.setPasted} onApply={(text) => void f.applyUri(text)} busy={f.parsing()} error={f.parseError()} masked={f.masked()} />
      <ParseNotes />
    </div>
  );
}
