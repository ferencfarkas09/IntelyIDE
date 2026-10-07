import { For, Show } from "solid-js";
import { t } from "../../i18n";
import { Badge } from "../../ui-kit";
import type { SchemaNode } from "./types";

const typeLabel = (n: SchemaNode): string => (n.type === "array" && n.items ? `${n.items.refName ?? n.items.type}[]` : n.refName && n.type === "object" ? n.refName : n.format ? `${n.type} (${n.format})` : n.type);

/** One schema row and its children. Pure presentation; examples are generated elsewhere. */
export function SchemaRow(props: { name?: string; node: SchemaNode; depth?: number }) {
  const depth = () => props.depth ?? 0;
  return (
    <div class="contract__srow" style={{ "--depth": depth() }}>
      <div class="contract__sline">
        <Show when={props.name !== undefined}>
          <span class="contract__sname">{props.name}</span>
        </Show>
        <span class="contract__stype">{typeLabel(props.node)}</span>
        <Show when={props.node.required}>
          <Badge size="sm" tone="warn">
            {t("contract.detail.required")}
          </Badge>
        </Show>
        <Show when={props.node.enum.length}>
          <span class="contract__sdesc">{t("contract.schema.enum", { values: props.node.enum.map(String).join(", ") })}</span>
        </Show>
        <Show when={props.node.description}>
          <span class="contract__sdesc">{props.node.description}</span>
        </Show>
        <Show when={props.node.circular}>
          <span class="contract__sdesc">{t("contract.schema.circular", { name: props.node.refName ?? "" })}</span>
        </Show>
        <Show when={props.node.truncated}>
          <span class="contract__sdesc">{t("contract.schema.truncated")}</span>
        </Show>
      </div>
      <For each={props.node.props}>{(p) => <SchemaRow name={p.name} node={p.node} depth={depth() + 1} />}</For>
      <Show when={props.node.items && props.node.items.props.length}>
        <SchemaRow name={`[ ] ${t("contract.schema.item")}`} node={props.node.items!} depth={depth() + 1} />
      </Show>
      <Show when={props.node.additional}>
        <SchemaRow name={t("contract.schema.additional")} node={props.node.additional!} depth={depth() + 1} />
      </Show>
    </div>
  );
}

export function SchemaView(props: { node: SchemaNode }) {
  return (
    <div class="contract__schema" role="tree">
      <SchemaRow node={props.node} />
    </div>
  );
}
