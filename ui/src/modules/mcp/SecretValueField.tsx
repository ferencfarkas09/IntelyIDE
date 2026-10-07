import { Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, Button, Input, Lock } from "../../ui-kit";

export interface SecretValueFieldProps {
  /** The variable or header this is the value of: part of every accessible name. */
  name: string;
  /** An item for this slot exists in the Keychain. */
  stored: boolean;
  /** Typing a replacement for the stored value. */
  replacing: boolean;
  /** The typed text; held by the parent's row and sent only inside `mcp_save`. */
  value: string;
  onInput: (value: string) => void;
  onReplace: () => void;
  onKeep: () => void;
  /** A slot that was saved without a value: say so, so the server's "Secret missing" state is not a surprise. */
  showMissing?: boolean;
  invalid?: boolean;
}

/**
 * The value of a secret slot ((design notes: mcp-management-spec) 7.3), after `KeyField`: typed once into a password field; a stored one shows a
 * mask and the badge "Stored in the Keychain" with Replace. There is no reveal and no copy, and no stored secret is ever read back.
 */
export function SecretValueField(props: SecretValueFieldProps) {
  const typing = () => !props.stored || props.replacing;
  return (
    <div class="mcp-secret">
      <Show
        when={typing()}
        fallback={
          <div class="mcp-secret__stored">
            <span class="mcp-secret__mask" role="img" aria-label={`${t("mcp.var.stored")}: ${props.name}`}>••••••••••••</span>
            <Badge tone="ok" size="sm" icon={Lock}>{t("mcp.var.stored")}</Badge>
            <Button size="sm" variant="ghost" aria-label={`${t("mcp.var.replace")}: ${props.name}`} onClick={props.onReplace}>{t("mcp.var.replace")}</Button>
          </div>
        }
      >
        <div class="mcp-secret__form">
          <Input
            size="sm"
            type="password"
            aria-label={`${props.stored ? t("mcp.var.newValue") : t("mcp.var.value")}: ${props.name}`}
            placeholder={props.stored ? t("mcp.var.newValue") : t("mcp.var.paste")}
            autocomplete="off"
            spellcheck={false}
            autocapitalize="off"
            invalid={props.invalid}
            value={props.value}
            onInput={(e) => props.onInput(e.currentTarget.value)}
          />
          <Show when={props.stored}>
            <Button size="sm" variant="ghost" onClick={props.onKeep}>{t("mcp.var.keepStored")}</Button>
          </Show>
        </div>
        <Show when={props.showMissing && !props.stored && props.value === ""}>
          <span class="mcp-secret__hint">{t("mcp.var.missing")}</span>
        </Show>
      </Show>
    </div>
  );
}
