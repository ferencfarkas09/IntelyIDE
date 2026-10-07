import { For, Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, Button, Copy, Dialog, toast, TypeChip } from "../../ui-kit";
import { JsonTree } from "../../ui-kit/JsonTree";
import { copyForms, isScalarObject, objectIdTime, scalarText, typeOf, type Json } from "./ejson";
import { scalarView } from "./ejsonView";

export interface CellDialogProps {
  path: string;
  value: Json | undefined;
  masked?: boolean;
  onClose: () => void;
}

const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => toast.info(t("mongoStudio.cellDialog.copied")));

/** The full value of a cell (Enter or Space on it): no truncation, and every way it can be copied. */
export function CellDialog(props: CellDialogProps) {
  const ty = () => typeOf(props.value);
  const complex = () => ty() === "Object" || ty() === "Array";
  return (
    <Dialog open size="lg" onClose={props.onClose} title={<span class="mg-celltitle"><span class="ui-mono">{props.path}</span> <TypeChip type={ty()} /></span>}
      footer={<Button variant="secondary" onClick={props.onClose}>{t("mongoStudio.cellDialog.close")}</Button>}>
      <Show when={!props.masked} fallback={<p class="ui-text-2">{t("mongoStudio.cellDialog.masked")}</p>}>
        <Show when={complex()} fallback={<pre class="mg-fullvalue ui-mono ui-selectable" tabIndex={0}>{scalarText(props.value)}</pre>}>
          <div class="mg-fulltree"><JsonTree label={t("mongoStudio.cellDialog.valueOf", { path: props.path })} value={props.value as Json} scalar={scalarView} openDepth={2} /></div>
        </Show>
        <Show when={ty() === "ObjectId"}>
          <p class="ui-text-2">{t("mongoStudio.cellDialog.created", { time: objectIdTime(scalarText(props.value))?.toISOString() ?? "" })}</p>
        </Show>
        <div class="mg-copyrow">
          <For each={copyForms(props.value)}>
            {(f) => <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(f.text)}>{f.label}</Button>}
          </For>
          <Show when={isScalarObject(props.value)}><Badge size="sm">{t("mongoStudio.cellDialog.typed")}</Badge></Show>
        </div>
      </Show>
    </Dialog>
  );
}
