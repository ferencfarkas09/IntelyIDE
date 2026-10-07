import { For, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, Checkbox, IconButton, Input, Plus, Trash2 } from "../../ui-kit";
import { SecretValueField } from "./SecretValueField";
import { isSecretName } from "./logic";
import { lockedSecret, rowProblem, type VarRow } from "./varRows";

export interface VarListEditorProps {
  kind: "env" | "header";
  /** The rows of the parent's store: the same objects for as long as the form is open, so typing never remounts a field. */
  rows: VarRow[];
  onPatch: (key: number, patch: Partial<VarRow>) => void;
  onAdd: () => void;
  onRemove: (key: number) => void;
  /** The label of the whole list, used in the group's accessible name. */
  label: string;
  disabled?: boolean;
}

const problemKey = {
  mcpBadVar: "mcp.err.mcpBadVar",
  mcpExecVar: "mcp.err.mcpExecVar",
  requirePlain: "mcp.var.requirePlain",
} as const;

/**
 * Environment variables (stdio) or headers (http): a name, then either a plain value or the secret control, and a Secret box. A name
 * that looks like a secret (`key`, `token`, `secret`, `password`, `passwd`, `auth`) ticks and locks the box. Names of the
 * exec-affecting list are refused live, with the same table as Rust ((design notes: mcp-management-spec) 2.4, 7.3).
 */
export function VarListEditor(props: VarListEditorProps) {
  const rowLabel = (row: VarRow, index: number) => row.name.trim() || t("mcp.var.rowName", { index: index + 1 });
  const rename = (row: VarRow, name: string) => {
    // a plain value is not left behind in memory when the new name turns the row into a secret
    if (!row.secret && isSecretName(name)) props.onPatch(row.key, { name, secret: true, value: "" });
    else props.onPatch(row.key, { name });
  };
  const toggleSecret = (row: VarRow, secret: boolean) => {
    if (secret) props.onPatch(row.key, { secret: true, value: "", replacing: false });
    else props.onPatch(row.key, { secret: false, secretValue: "", replacing: false });
  };

  return (
    <div class="mcp-vars" role="group" aria-label={props.label}>
      <Show when={props.rows.length > 0}>
        <div class="mcp-vars__head" aria-hidden="true">
          <span>{t("mcp.var.name")}</span>
          <span>{t("mcp.var.value")}</span>
          <span>{t("mcp.var.secret")}</span>
          <span />
        </div>
      </Show>
      <For each={props.rows}>
        {(row, index) => {
          const problem = () => rowProblem(props.kind, row, props.rows);
          const locked = () => lockedSecret(row);
          const secret = () => row.secret || locked();
          return (
            <div class="mcp-vars__row" data-secret={secret() ? "" : undefined}>
              <Input
                size="sm"
                class="mcp-mono"
                aria-label={t("mcp.var.rowName", { index: index() + 1 })}
                placeholder={props.kind === "env" ? "LOG_LEVEL" : "X-Team"}
                autocomplete="off"
                spellcheck={false}
                autocapitalize="off"
                readOnly={row.existing && row.stored}
                invalid={!!problem() && problem() !== "requirePlain"}
                disabled={props.disabled}
                value={row.name}
                onInput={(e) => rename(row, e.currentTarget.value)}
              />
              <Show
                when={secret()}
                fallback={
                  <Input
                    size="sm"
                    aria-label={t("mcp.var.rowValue", { name: rowLabel(row, index()) })}
                    placeholder={t("mcp.var.value")}
                    autocomplete="off"
                    spellcheck={false}
                    invalid={problem() === "requirePlain"}
                    disabled={props.disabled}
                    value={row.value}
                    onInput={(e) => props.onPatch(row.key, { value: e.currentTarget.value })}
                  />
                }
              >
                <SecretValueField
                  name={rowLabel(row, index())}
                  stored={row.stored}
                  replacing={row.replacing}
                  value={row.secretValue}
                  showMissing={row.existing}
                  onInput={(secretValue) => props.onPatch(row.key, { secretValue })}
                  onReplace={() => props.onPatch(row.key, { replacing: true })}
                  onKeep={() => props.onPatch(row.key, { replacing: false, secretValue: "" })}
                />
              </Show>
              <Checkbox
                size="sm"
                aria-label={t("mcp.var.rowSecret", { name: rowLabel(row, index()) })}
                checked={secret()}
                disabled={props.disabled || locked()}
                onChange={(next) => toggleSecret(row, next)}
              />
              <IconButton icon={Trash2} size="sm" label={t("mcp.var.remove", { name: rowLabel(row, index()) })} disabled={props.disabled} onClick={() => props.onRemove(row.key)} />
              <Show when={locked()}>
                <p class="mcp-vars__note">{t("mcp.var.secretLocked")}</p>
              </Show>
              <Show when={problem()}>
                {(p) => (
                  <p class="mcp-vars__note" data-tone="danger" role="alert">
                    {t(problemKey[p()])}
                  </p>
                )}
              </Show>
            </div>
          );
        }}
      </For>
      <div class="mcp-vars__add">
        <Button size="sm" variant="ghost" icon={Plus} disabled={props.disabled} onClick={props.onAdd}>
          {props.kind === "env" ? t("mcp.var.add") : t("mcp.var.addHeader")}
        </Button>
      </div>
    </div>
  );
}
