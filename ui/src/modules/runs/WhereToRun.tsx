import { For, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, Checkbox, IconButton, Minus, Plus, VisuallyHidden } from "../../ui-kit";
import type { PlaceCounts, PlaceRow } from "./newRunLogic";

const WHY = { unchecked: "runs.where.unchecked", unreachable: "runs.where.unreachable", needsSetup: "runs.where.needsSetup", full: "runs.where.full" } as const;

/** "Where to run": this Mac and each enabled server with a count stepper, a summary, and the numbering switch. */
export function WhereToRun(props: {
  rows: readonly PlaceRow[];
  counts: PlaceCounts;
  summary: string;
  numbering: boolean;
  disabled?: boolean;
  onCount: (key: string, n: number) => void;
  onNumbering: (on: boolean) => void;
  onSettings: () => void;
}) {
  const n = (r: PlaceRow) => props.counts[r.key] ?? 0;
  return (
    <fieldset class="newrun__field newrun__where">
      <legend class="newrun__label">{t("runs.where.title")}</legend>
      <ul class="where__rows">
        <For each={props.rows}>
          {(r) => (
            <li class="where__row" role="group" aria-label={r.name} data-off={r.max === 0 ? "" : undefined} data-key={r.key || "mac"}>
              <span class="where__name">{r.name}</span>
              <span class="where__note">
                <Show when={r.why} fallback={<Show when={r.capacity}>{t("runs.where.free", { free: r.max, max: r.capacity })}</Show>}>
                  {t(WHY[r.why!], { max: r.capacity ?? 0 })}
                </Show>
              </span>
              <Show when={r.why && r.why !== "full"}>
                <Button size="sm" variant="ghost" onClick={props.onSettings}>
                  {t("runs.where.settings")}
                </Button>
              </Show>
              <span class="where__stepper">
                <IconButton icon={Minus} size="sm" label={t("runs.where.fewer", { name: r.name })} disabled={props.disabled || n(r) <= 0} onClick={() => props.onCount(r.key, n(r) - 1)} />
                <span class="where__count ui-tnum" data-testid="where-count" aria-hidden="true">{n(r)}</span>
                <VisuallyHidden>{t("runs.where.count", { name: r.name })}: {n(r)}</VisuallyHidden>
                <IconButton icon={Plus} size="sm" label={t("runs.where.more", { name: r.name })} disabled={props.disabled || n(r) >= r.max} onClick={() => props.onCount(r.key, n(r) + 1)} />
              </span>
            </li>
          )}
        </For>
      </ul>
      <p class="where__summary" aria-live="polite">{props.summary}</p>
      <Checkbox size="sm" checked={props.numbering} onChange={props.onNumbering} label={t("runs.where.number")} />
      <small class="newrun__provider-note">{t("runs.where.numberHint")}</small>
    </fieldset>
  );
}
