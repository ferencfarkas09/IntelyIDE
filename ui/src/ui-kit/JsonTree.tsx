import { t } from "../i18n";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Copy } from "./icons";
import { IconButton } from "./IconButton";
import { Tree, TreeRow } from "./TreeRow";
import { TypeChip } from "./TypeChip";
import "./data.css";

// Imported by path (`ui-kit/JsonTree`). Lazy: only the rows under expanded nodes exist, and a node with many children lists
// 100 at a time, so a document with a long array stays cheap.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface ScalarView {
  /** What is shown. */
  text: string;
  /** Type name for the chip and the colour (`ObjectId`, `Date`, `String`...). */
  type: string;
}

export interface JsonTreeProps {
  value: JsonValue;
  label: string;
  /** Text for the root row (e.g. the document id); default `{ n fields }`. */
  rootLabel?: string;
  /** Depth that starts open (default 1: the top-level fields). */
  openDepth?: number;
  /** Turns an object that is really one typed value (an ObjectId wrapper) into a leaf. */
  scalar?: (v: object) => ScalarView | undefined;
  /** Paths whose value is hidden until revealed (credential fields). */
  masked?: (path: readonly string[]) => boolean;
  onCopy?: (path: readonly string[], value: JsonValue) => void;
  /** Strings longer than this are cut with "Show full value" (default 1024). */
  maxText?: number;
}

interface Row {
  key: string;
  path: readonly string[];
  name: string;
  depth: number;
  value: JsonValue;
  scalar?: ScalarView;
  kind: "scalar" | "object" | "array" | "more";
  count: number;
  /** For "more" rows: the node it extends. */
  parentKey?: string;
}

const PAGE = 100;
const keyOf = (path: readonly string[]) => JSON.stringify(path);

function scalarOf(v: JsonValue, scalar?: JsonTreeProps["scalar"]): ScalarView | undefined {
  if (v === null) return { text: "null", type: "Null" };
  if (typeof v === "string") return { text: v, type: "String" };
  if (typeof v === "boolean") return { text: String(v), type: "Boolean" };
  if (typeof v === "number") return { text: String(v), type: Number.isInteger(v) ? "Int32" : "Double" };
  if (!Array.isArray(v)) return scalar?.(v);
  return undefined;
}

export function JsonTree(props: JsonTreeProps) {
  const open = () => props.openDepth ?? 1;
  const [toggled, setToggled] = createSignal<Record<string, boolean>>({});
  const [shown, setShown] = createSignal<Record<string, number>>({});
  const [full, setFull] = createSignal<Record<string, boolean>>({});
  const [cursor, setCursor] = createSignal<string>(keyOf([]));
  const isOpen = (key: string, depth: number) => toggled()[key] ?? depth < open();
  const maxText = () => props.maxText ?? 1024;

  const rows = createMemo(() => {
    const out: Row[] = [];
    const visit = (value: JsonValue, path: readonly string[], name: string, depth: number) => {
      const key = keyOf(path);
      const sc = scalarOf(value, props.scalar);
      if (sc) return void out.push({ key, path, name, depth, value, scalar: sc, kind: "scalar", count: 0 });
      const isArr = Array.isArray(value);
      const entries: [string, JsonValue][] = isArr ? (value as JsonValue[]).map((x, i) => [String(i), x]) : Object.entries(value as { [k: string]: JsonValue });
      out.push({ key, path, name, depth, value, kind: isArr ? "array" : "object", count: entries.length });
      if (!isOpen(key, depth)) return;
      const limit = shown()[key] ?? PAGE;
      for (const [k, v] of entries.slice(0, limit)) visit(v, [...path, k], k, depth + 1);
      if (entries.length > limit) out.push({ key: `${key}#more`, path, name: "", depth: depth + 1, value: null, kind: "more", count: entries.length - limit, parentKey: key });
    };
    visit(props.value, [], props.rootLabel ?? "", 0);
    return out;
  });

  const toggle = (row: Row) => setToggled((t) => ({ ...t, [row.key]: !isOpen(row.key, row.depth) }));

  function onKeyDown(e: KeyboardEvent) {
    const list = rows();
    const at = Math.max(0, list.findIndex((r) => r.key === cursor()));
    const row = list[at];
    const go = (i: number) => {
      const next = list[Math.min(Math.max(i, 0), list.length - 1)];
      if (!next) return;
      setCursor(next.key);
      queueMicrotask(() => (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView?.({ block: "nearest" }));
    };
    switch (e.key) {
      case "ArrowDown": return (e.preventDefault(), go(at + 1));
      case "ArrowUp": return (e.preventDefault(), go(at - 1));
      case "Home": return (e.preventDefault(), go(0));
      case "End": return (e.preventDefault(), go(list.length - 1));
      case "ArrowRight":
        if (row && (row.kind === "object" || row.kind === "array")) {
          e.preventDefault();
          if (!isOpen(row.key, row.depth)) toggle(row);
          else go(at + 1);
        }
        return;
      case "ArrowLeft":
        if (row && (row.kind === "object" || row.kind === "array") && isOpen(row.key, row.depth)) return (e.preventDefault(), toggle(row));
        if (row && row.depth > 0) {
          e.preventDefault();
          const parent = list.slice(0, at).reverse().find((r) => r.depth === row.depth - 1);
          if (parent) go(list.indexOf(parent));
        }
        return;
      case "Enter":
      case " ":
        if (!row) return;
        e.preventDefault();
        if (row.kind === "more") return setShown((s) => ({ ...s, [row.parentKey!]: (s[row.parentKey!] ?? PAGE) + PAGE }));
        if (row.kind !== "scalar") toggle(row);
        return;
      case "c":
      case "C":
        if ((e.metaKey || e.ctrlKey) && row && row.kind !== "more") return (e.preventDefault(), props.onCopy?.(row.path, row.value));
    }
  }

  const valueView = (row: Row): JSX.Element => {
    if (row.kind === "object") return <span class="ui-json__summary">{`{ ${row.count} ${row.count === 1 ? "field" : "fields"} }`}</span>;
    if (row.kind === "array") return <span class="ui-json__summary">{`[ ${row.count} ]`}</span>;
    const sc = row.scalar!;
    if (props.masked?.(row.path)) return <span class="ui-json__value" data-type="masked">••••••••</span>;
    const long = sc.type === "String" && sc.text.length > maxText() && !full()[row.key];
    return (
      <>
        <span class="ui-json__value" data-type={sc.type}>
          {sc.type === "String" ? `"${long ? sc.text.slice(0, maxText()) : sc.text}${long ? "…" : ""}"` : sc.text}
        </span>
        <Show when={long}>
          <button type="button" class="ui-json__more" onClick={(e) => (e.stopPropagation(), setFull((f) => ({ ...f, [row.key]: true })))}>
            {t("kit.showFull")}
          </button>
        </Show>
      </>
    );
  };

  return (
    <Tree aria-label={props.label} class="ui-json" tabIndex={0} onKeyDown={onKeyDown}>
      <For each={rows()}>
        {(row) => (
          <Show
            when={row.kind !== "more"}
            fallback={
              <TreeRow compact depth={row.depth} data-key={row.key} cursor={cursor() === row.key} onClick={() => (setCursor(row.key), setShown((s) => ({ ...s, [row.parentKey!]: (s[row.parentKey!] ?? PAGE) + PAGE })))}>
                <span class="ui-json__more">{`Show ${Math.min(PAGE, row.count)} more (${row.count} left)`}</span>
              </TreeRow>
            }
          >
            <TreeRow
              compact
              depth={row.depth}
              data-key={row.key}
              expanded={row.kind === "scalar" ? undefined : isOpen(row.key, row.depth)}
              cursor={cursor() === row.key}
              onToggle={() => toggle(row)}
              onClick={() => setCursor(row.key)}
              trailing={row.scalar ? <TypeChip type={row.scalar.type} /> : <TypeChip type={row.kind === "array" ? "Array" : "Object"} />}
              actions={props.onCopy ? <IconButton icon={Copy} label={t("kit.copyValue")} size="sm" iconSize={12} tabIndex={-1} onClick={(e) => (e.stopPropagation(), props.onCopy?.(row.path, row.value))} /> : undefined}
            >
              <Show when={row.depth > 0 || props.rootLabel}>
                <span class="ui-json__key">{row.name}</span>
                <span class="ui-json__colon">:</span>
              </Show>
              {valueView(row)}
            </TreeRow>
          </Show>
        )}
      </For>
    </Tree>
  );
}
