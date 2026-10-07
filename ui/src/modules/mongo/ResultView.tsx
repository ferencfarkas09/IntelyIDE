import { t } from "../../i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import { ArrowDown, ArrowUp, Checkbox, Columns3, Eye, EyeOff, IconButton, Popover, Button, Switch, toast, TypeChip, readStored, writeStored } from "../../ui-kit";
import { DataGrid, type GridColumn, type GridSort } from "../../ui-kit/DataGrid";
import { JsonTree } from "../../ui-kit/JsonTree";
import { CellDialog } from "./CellDialog";
import { ValueCell, valueAt } from "./Cells";
import { ejsonOf, inferColumns, maskDoc, scalarText, shellOf, typeOf, type Doc, type Json } from "./ejson";
import { scalarView } from "./ejsonView";
import { isSensitivePath, sensitivePaths } from "./logic";
import type { CollectionModel } from "./model";
import { lint } from "./shellLiteral";

const colKey = (m: CollectionModel) => `intely.mongo.cols.${m.ref.connectionId}.${m.ref.db}.${m.ref.collection}`;

interface ColState {
  order: string[];
  hidden: string[];
}

function readCols(key: string): ColState {
  try {
    const v = JSON.parse(readStored(key) ?? "null") as Partial<ColState> | null;
    return { order: Array.isArray(v?.order) ? v!.order!.filter((x) => typeof x === "string") : [], hidden: Array.isArray(v?.hidden) ? v!.hidden!.filter((x) => typeof x === "string") : [] };
  } catch {
    return { order: [], hidden: [] };
  }
}

function sortOf(text: string): GridSort | null {
  if (!text.trim() || !lint(text).ok) return null;
  const m = /^\s*\{\s*["']?([\w$.]+)["']?\s*:\s*(-?1)\s*,?\s*\}\s*$/.exec(text);
  return m ? { column: m[1], dir: m[2] === "-1" ? -1 : 1 } : null;
}

/** Column picker: show or hide, and move up or down (the keyboard alternative to dragging). */
function ColumnPicker(props: { all: string[]; hidden: Set<string>; typeOf: (c: string) => string | undefined; onToggle: (c: string) => void; onMove: (c: string, by: -1 | 1) => void; onReset: () => void }) {
  return (
    <Popover
      aria-label={t("mongoStudio.result.columns")}
      placement="bottom-end"
      trigger={(tp) => (
        <Button {...tp} size="sm" variant="secondary" icon={Columns3}>
          {t("mongoStudio.result.columns")} <span class="ui-tnum ui-text-3" style={{ "margin-left": "6px" }}>{props.all.length - props.hidden.size}/{props.all.length}</span>
        </Button>
      )}
    >
      <div class="mg-cols">
        <div class="mg-cols__list" role="group" aria-label={t("mongoStudio.result.visibleColumns")}>
          <For each={props.all}>
            {(c, i) => (
              <div class="mg-cols__row">
                <Checkbox checked={!props.hidden.has(c)} onChange={() => props.onToggle(c)} aria-label={t("mongoStudio.result.show", { column: c })} label={<span class="ui-mono ui-truncate">{c}</span>} />
                <Show when={props.typeOf(c)}>{(ty) => <TypeChip type={ty()} />}</Show>
                <span class="mg-cols__move">
                  <IconButton icon={ArrowUp} label={t("mongoStudio.result.moveUp", { column: c })} size="sm" iconSize={12} disabled={i() === 0} onClick={() => props.onMove(c, -1)} />
                  <IconButton icon={ArrowDown} label={t("mongoStudio.result.moveDown", { column: c })} size="sm" iconSize={12} disabled={i() === props.all.length - 1} onClick={() => props.onMove(c, 1)} />
                </span>
              </div>
            )}
          </For>
        </div>
        <div class="mg-cols__foot"><Button size="sm" variant="ghost" onClick={props.onReset}>{t("mongoStudio.result.resetColumns")}</Button></div>
      </div>
    </Popover>
  );
}

export interface ResultViewProps {
  m: CollectionModel;
}

/** The documents of the current window as a table, a tree or JSON (the choice is remembered per collection). */
export function ResultView(props: ResultViewProps) {
  const m = () => props.m;
  const [cols, setCols] = createSignal<ColState>(readCols(colKey(props.m)));
  const [revealed, setRevealed] = createSignal<Set<string>>(new Set());
  const [cell, setCell] = createSignal<{ path: string; value: Json | undefined; masked: boolean }>();
  const [ejson, setEjson] = createSignal(false);
  const sens = createMemo(() => sensitivePaths(m().digest()));
  const persist = (c: ColState) => (setCols(c), writeStored(colKey(m()), JSON.stringify(c)));

  const known = createMemo(() => {
    const fromDocs = inferColumns(m().docs() as Doc[]);
    const fromDigest = (m().digest()?.fields ?? []).filter((f) => !f.path.includes(".")).map((f) => f.path);
    const all = [...new Set([...fromDocs, ...fromDigest])];
    const order = cols().order;
    const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length + all.indexOf(c));
    return all.sort((a, b) => (a === "_id" ? -1 : b === "_id" ? 1 : rank(a) - rank(b)));
  });
  const hidden = createMemo(() => new Set(cols().hidden));
  const visible = createMemo(() => known().filter((c) => !hidden().has(c)));
  const topType = (c: string) => m().digest()?.fields.find((f) => f.path === c)?.types[0]?.type;
  const isMasked = (c: string) => sens().has(c) && !revealed().has(c);

  const columns = createMemo<GridColumn<Doc>[]>(() =>
    visible().map((c) => {
      const ty = topType(c);
      const numeric = ty === "Int32" || ty === "Int64" || ty === "Double" || ty === "Decimal128" || ty === "int" || ty === "double" || ty === "long";
      return {
        id: c,
        title: c,
        width: c === "_id" ? 124 : ty === "Date" ? 236 : ty === "ObjectId" ? 150 : numeric ? 116 : 170,
        sortable: true,
        align: numeric ? "end" : "start",
        meta: (
          <>
            <Show when={ty}>{(x) => <TypeChip type={x()} />}</Show>
            <Show when={sens().has(c)}>
              <IconButton icon={revealed().has(c) ? EyeOff : Eye} label={revealed().has(c) ? t("mongoStudio.result.hide", { column: c }) : t("mongoStudio.result.reveal", { column: c })} size="sm" iconSize={12} onClick={(e) => (e.stopPropagation(), setRevealed((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; }))} />
            </Show>
          </>
        ),
        cell: (row) => <ValueCell v={valueAt(row, c)} masked={isMasked(c)} />,
        text: (row) => (isMasked(c) ? t("mongoStudio.result.hiddenText") : scalarText(valueAt(row, c))),
      };
    }),
  );

  const move = (c: string, by: -1 | 1) => {
    const list = known().slice();
    const i = list.indexOf(c);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    persist({ ...cols(), order: list });
  };
  const toggle = (c: string) => persist({ ...cols(), hidden: hidden().has(c) ? cols().hidden.filter((x) => x !== c) : [...cols().hidden, c] });

  const copyCell = (row: Doc, col: string, path: boolean) => {
    const v = valueAt(row, col);
    const text = path ? col : isMasked(col) ? "" : scalarText(v);
    if (!text) return toast.info(t("mongoStudio.result.revealFirst"));
    void navigator.clipboard?.writeText(text).then(() => toast.info(path ? t("mongoStudio.result.pathCopied") : t("mongoStudio.result.valueCopied")));
  };

  /** A sensitive value stays dots in every view until its column is revealed. */
  const hiddenPath = (p: readonly string[]) => isSensitivePath(sens(), p) && !revealed().has(p[0]);
  const jsonText = createMemo(() => {
    const list = m().docs() as Doc[];
    return list.map((d) => { const safe = maskDoc(d, hiddenPath); return ejson() ? ejsonOf(safe) : shellOf(safe); }).join(ejson() ? ",\n" : "\n");
  });
  const docLabel = (d: Doc) => scalarText(d._id);

  return (
    <div class="mg-result">
      <div class="mg-result__bar">
        <Show when={m().view() === "table"}>
          <ColumnPicker all={known()} hidden={hidden()} typeOf={topType} onToggle={toggle} onMove={move} onReset={() => persist({ order: [], hidden: [] })} />
        </Show>
        <Show when={m().view() === "json"}>
          <Switch size="sm" checked={ejson()} onChange={setEjson} aria-label={t("mongoStudio.result.extendedJson")} label={t("mongoStudio.result.extendedJson")} />
        </Show>
      </div>
      <div class="mg-result__body">
        <Show when={m().view() === "table"}>
          <DataGrid
            label={t("mongoStudio.result.gridLabel", { collection: m().ref.collection })}
            columns={columns()}
            rows={m().docs() as Doc[]}
            rowKey={(d, i) => `${m().page()}-${i}-${docLabel(d)}`}
            firstRowNumber={m().page() * m().pageSize() + 1}
            sort={sortOf(m().q().sort)}
            onSort={(next) => m().sortBy(next?.column ?? "", next?.dir ?? null)}
            onActivate={(row, _i, col) => setCell({ path: col, value: valueAt(row, col), masked: isMasked(col) })}
            onCopy={copyCell}
          />
        </Show>
        <Show when={m().view() === "tree"}>
          <div class="mg-trees">
            <For each={m().docs() as Doc[]}>
              {(d, i) => (
                <div class="mg-trees__doc">
                  <JsonTree label={t("mongoStudio.result.documentN", { n: m().page() * m().pageSize() + i() + 1 })} value={d} rootLabel={docLabel(d)} openDepth={i() === 0 ? 2 : 0} scalar={scalarView} masked={hiddenPath} onCopy={(p, v) => (hiddenPath(p) ? toast.info(t("mongoStudio.result.revealFirst")) : void navigator.clipboard?.writeText(typeOf(v) === "Object" || typeOf(v) === "Array" ? ejsonOf(maskDoc(v as Doc, (q) => hiddenPath([...p, ...q]))) : scalarText(v)).then(() => toast.info(t("mongoStudio.result.copied"))))} />
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={m().view() === "json"}>
          <pre class="mg-json ui-mono ui-selectable" tabIndex={0} aria-label={t("mongoStudio.result.jsonLabel")}>{jsonText()}</pre>
        </Show>
      </div>
      <Show when={cell()}>{(c) => <CellDialog path={c().path} value={c().value} masked={c().masked} onClose={() => setCell(undefined)} />}</Show>
    </div>
  );
}

