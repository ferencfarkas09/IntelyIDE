// Full-window overlay while files are dragged over the window: names the target that will receive the drop and
// outlines it. Mounted once as a platform overlay; it never takes pointer events (the drag source keeps them).
import { createMemo, Show } from "solid-js";
import { dropState } from "../../platform/dropzone";
import { Icon, Upload } from "../../ui-kit";
import { t } from "../../i18n";
import "./attachments.css";

export default function DropOverlay() {
  const s = dropState;
  const names = createMemo(() => {
    const named = s().items.map((i) => i.name).filter(Boolean);
    if (named.length === 0) return s().items.length > 1 ? t("attach.items", { n: s().items.length }) : "";
    return named.length > 3 ? t("shell.close.andMore", { head: named.slice(0, 3).join(", "), n: named.length - 3 }) : named.join(", ");
  });
  return (
    <Show when={s().active}>
      <div class="att-overlay" data-testid="drop-overlay" data-refused={s().target ? undefined : ""} role="status" aria-live="polite">
        <Show when={s().target?.rect}>{(r) => <div class="att-overlay__target" style={{ left: `${r().x}px`, top: `${r().y}px`, width: `${r().width}px`, height: `${r().height}px` }} data-testid="drop-target-outline" />}</Show>
        <div class="att-overlay__pill">
          <Icon icon={Upload} size={20} />
          <Show when={s().target} fallback={<span class="att-overlay__title">{s().hint}</span>}>
            {(tg) => <span class="att-overlay__title">{tg().title ?? t("attach.dropTo", { label: tg().label })}</span>}
          </Show>
          <Show when={names()}>
            <span class="att-overlay__sub ui-truncate">{names()}</span>
          </Show>
        </div>
      </div>
    </Show>
  );
}
