import { Show } from "solid-js";
import { t } from "../../i18n";
import { cellText, dateMs, getPath, isoOf, objectIdTime, relativeTime, typeOf, type Doc, type Json } from "./ejson";

const NUMERIC = new Set(["Int32", "Int64", "Double", "Decimal128"]);
export const isNumeric = (v: Json | undefined): boolean => NUMERIC.has(typeOf(v));

/** One value in a grid cell: typed rendering, sensitive values hidden until revealed. */
export function ValueCell(props: { v: Json | undefined; masked?: boolean; now?: number }) {
  const ty = () => typeOf(props.v);
  return (
    <Show when={!props.masked} fallback={<span class="mg-cell mg-cell--masked" title={t("mongoStudio.cell.hiddenTitle")}>••••••••</span>}>
      <Show when={props.v !== undefined} fallback={<span class="mg-cell mg-cell--missing" title={t("mongoStudio.cell.missingTitle")}>—</span>}>
        {ty() === "ObjectId" ? (
          <span class="mg-cell mg-cell--oid ui-mono" title={t("mongoStudio.cell.oidTitle", { oid: cellOid(props.v), created: objectIdTime(cellOid(props.v))?.toISOString() ?? "" })}>{cellOid(props.v).slice(0, 8)}</span>
        ) : ty() === "Date" ? (
          <span class="mg-cell mg-cell--date" title={isoOf(dateMs(props.v) ?? NaN)}>
            <span class="ui-mono">{isoOf(dateMs(props.v) ?? NaN).replace(/\.\d{3}Z$/, "Z")}</span>
            <span class="mg-cell__rel">{relativeTime(dateMs(props.v) ?? 0, props.now)}</span>
          </span>
        ) : ty() === "Null" ? (
          <span class="mg-cell mg-cell--null">{t("mongoStudio.cell.null")}</span>
        ) : ty() === "Boolean" ? (
          <span class="mg-cell mg-cell--bool ui-mono">{String(props.v)}</span>
        ) : NUMERIC.has(ty()) ? (
          <span class="mg-cell mg-cell--num ui-mono" title={ty()}>{cellText(props.v)}</span>
        ) : ty() === "Array" ? (
          <span class="mg-cell mg-cell--complex">{`[ ${(props.v as Json[]).length} ]`}</span>
        ) : ty() === "Object" ? (
          <span class="mg-cell mg-cell--complex">{cellText(props.v)}</span>
        ) : ty() === "String" && (props.v as string) === "" ? (
          <span class="mg-cell mg-cell--null">""</span>
        ) : (
          <span class="mg-cell">{cellText(props.v)}</span>
        )}
      </Show>
    </Show>
  );
}

function cellOid(v: Json | undefined): string {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof v.$oid === "string" ? v.$oid : "";
}

export const valueAt = (d: Doc, path: string): Json | undefined => (path in d ? d[path] : getPath(d, path));
