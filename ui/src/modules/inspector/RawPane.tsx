import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { AgentEvent } from "../../store/agent-types";
import { Copy, EmptyState, IconButton, Input, Search, toast } from "../../ui-kit";
import { formatJson, offsetLabel } from "./format";

const PAGE = 200;

export function RawPane(props: { events: readonly AgentEvent[]; start: number }) {
  const [query, setQuery] = createSignal("");
  const [limit, setLimit] = createSignal(PAGE);
  const [open, setOpen] = createSignal<number | null>(null);
  const matches = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? props.events.filter((e) => e.kind.includes(q) || formatJson(e).toLowerCase().includes(q)) : props.events;
  });
  const copy = (e: AgentEvent) =>
    void navigator.clipboard?.writeText(formatJson(e)).then(
      () => toast.success(t("inspector.raw.copied")),
      () => toast.error(t("inspector.copyFail"), t("inspector.noClipboard")),
    );

  return (
    <div class="insp-raw">
      <Input size="sm" aria-label={t("inspector.raw.filter")} placeholder={t("inspector.raw.filterPlaceholder")} leading={<Search size={14} />} value={query()} onInput={(e) => (setQuery(e.currentTarget.value), setLimit(PAGE))} />
      <Show when={matches().length > 0} fallback={<EmptyState icon={Search} size="sm" title={props.events.length ? t("inspector.raw.noMatch") : t("inspector.raw.none")} />}>
        <ol class="insp-events" aria-label={t("inspector.raw.label")}>
          <For each={matches().slice(0, limit())}>
            {(e) => (
              <li class="insp-event" data-open={open() === e.seq ? "" : undefined}>
                <button type="button" class="insp-event__head" aria-expanded={open() === e.seq} onClick={() => setOpen(open() === e.seq ? null : e.seq)}>
                  <span class="insp-event__seq ui-tnum">{e.seq}</span>
                  <span class="insp-event__kind">{e.kind}</span>
                  <span class="insp-event__time ui-tnum">{offsetLabel(e.ts, props.start)}</span>
                </button>
                <Show when={open() === e.seq}>
                  <div class="insp-event__json">
                    <IconButton icon={Copy} size="sm" label={t("inspector.raw.copy")} class="insp-event__copy" onClick={() => copy(e)} />
                    <pre tabindex="0">{formatJson(e)}</pre>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ol>
        <Show when={matches().length > limit()}>
          <button type="button" class="insp-more" onClick={() => setLimit(limit() + PAGE)}>
            {t("inspector.raw.more", { n: Math.min(PAGE, matches().length - limit()), rest: matches().length - limit() })}
          </button>
        </Show>
      </Show>
    </div>
  );
}
