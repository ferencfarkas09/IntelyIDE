import { createSignal, onCleanup, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { Badge, Button, Input, Lock } from "../../ui-kit";

export interface KeyFieldProps {
  /** What the key is called in this mode. */
  kind: "apiKey" | "token";
  hasKey: boolean;
  onSave: (value: string) => Promise<void> | void;
  onRemove: () => Promise<void> | void;
}

/**
 * A key is typed once. After saving the field is cleared and only a masked placeholder shows: there is no reveal and no
 * copy, only Replace and Remove. The typed text lives in this component alone and goes nowhere but `onSave`.
 */
export function KeyField(props: KeyFieldProps) {
  const [value, setValue] = createSignal("");
  const [replacing, setReplacing] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const editing = () => !props.hasKey || replacing();
  const word = (part: "label" | "stored" | "new" | "paste" | "remove") => t(`providers.key.${props.kind}.${part}` as MessageKey);
  onCleanup(() => setValue(""));

  async function save(e: Event) {
    e.preventDefault();
    const typed = value();
    if (!typed.trim() || busy()) return;
    setValue("");
    setBusy(true);
    try {
      await props.onSave(typed.trim());
      setReplacing(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await props.onRemove();
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  }

  return (
    <div class="keyfield">
      <Show
        when={editing()}
        fallback={
          <div class="keyfield__stored">
            <span class="keyfield__mask" role="img" aria-label={word("stored")}>••••••••••••••••</span>
            <Badge tone="ok" icon={Lock}>{t("providers.key.stored")}</Badge>
            <Button size="sm" variant="secondary" onClick={() => setReplacing(true)}>{t("providers.key.replace")}</Button>
            <Show when={!confirmRemove()} fallback={
              <>
                <Button size="sm" variant="danger" loading={busy()} onClick={() => void remove()}>{word("remove")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>{t("providers.key.keep")}</Button>
              </>
            }>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>{t("providers.key.remove")}</Button>
            </Show>
          </div>
        }
      >
        <form class="keyfield__form" onSubmit={save}>
          <Input
            size="sm"
            type="password"
            aria-label={props.hasKey ? word("new") : word("label")}
            placeholder={props.hasKey ? word("new") : word("paste")}
            autocomplete="off"
            spellcheck={false}
            autocapitalize="off"
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy()} disabled={!value().trim()}>{t("providers.key.save")}</Button>
          <Show when={props.hasKey}>
            <Button size="sm" variant="ghost" onClick={() => (setValue(""), setReplacing(false))}>{t("providers.key.cancel")}</Button>
          </Show>
        </form>
      </Show>
      <p class="keyfield__note">{t("providers.key.note")}</p>
    </div>
  );
}
