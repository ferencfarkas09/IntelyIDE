import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ArrowRight, Badge, Button, CircleAlert, CircleCheck, Clock, Kbd, Pencil, Play, Sparkles, TriangleAlert, X } from "../../ui-kit";
import { dateBounds } from "./logic";
import type { CollectionModel } from "./model";

export interface ReviewStripProps {
  m: CollectionModel;
  dangerous: boolean;
  onEdit: () => void;
  /** The tab's collection: a draft for another one offers to open it. */
  collection?: string;
  onOpenCollection?: (collection: string) => void;
}

/** The AI draft waiting for a human: explanation, assumptions, validation and plan, then Run, Edit or Discard. Nothing runs by itself. */
export function ReviewStrip(props: ReviewStripProps) {
  const ai = () => props.m.ai;
  const [armed, setArmed] = createSignal(false);
  const warnings = () => ai().draft()?.warnings ?? [];
  const needsConfirm = () => !!ai().draft()?.extraConfirm && props.dangerous;
  const run = () => {
    if (needsConfirm() && !armed()) return setArmed(true);
    setArmed(false);
    void ai().runDraft();
  };
  return (
    <Show when={ai().draft()}>
      {(d) => (
        <section class="mg-review" aria-label={t("mongoLoud.review.aria")} data-warn={warnings().length ? "" : undefined}>
          <header class="mg-review__head">
            <Sparkles size={14} class="mg-ai__spark" />
            <strong>{t("mongoLoud.review.title")}</strong>
            <span class="ui-text-2">{t("mongoLoud.review.sub")}</span>
            <Show when={ai().edited()}><Badge tone="warn" size="sm">{t("mongoLoud.review.edited")}</Badge></Show>
            <span class="mg-review__meta ui-text-3">{ai().result()?.model} · {((ai().result()?.tookMs ?? 0) / 1000).toFixed(1)} s{(ai().result()?.repairs ?? 0) > 0 ? ` · ${t("mongoLoud.review.repairs", { n: ai().result()?.repairs ?? 0 })}` : ""}</span>
          </header>
          <p class="mg-review__why">{d().explanation}</p>
          <Show when={d().assumptions.length}>
            <ul class="mg-review__list" aria-label={t("mongoLoud.review.assumptions")}>
              <For each={d().assumptions}>{(a) => <li>{a}</li>}</For>
            </ul>
          </Show>
          <div class="mg-review__checks">
            <Badge tone="ok" icon={CircleCheck} size="sm">{t("mongoLoud.review.valid")}</Badge>
            <For each={dateBounds(d().filter)}>{(b) => <Badge size="sm" icon={Clock} title={t("mongoLoud.review.dateTitle")}>{b}</Badge>}</For>
            <Show when={d().plan}>
              {(p) => (
                <Badge tone={p().collscan ? "warn" : "ok"} icon={p().collscan ? TriangleAlert : CircleCheck} size="sm">
                  {p().collscan ? (p().estimatedDocs ? t("mongoLoud.review.collscanDocs", { n: p().estimatedDocs! }) : t("mongoLoud.review.collscan")) : t("mongoLoud.review.index", { names: p().indexNames.join(", ") })}
                </Badge>
              )}
            </Show>
            <For each={warnings()}>{(w) => <Badge tone="warn" icon={CircleAlert} size="sm">{w}</Badge>}</For>
          </div>
          <Show when={d().collection && props.collection && d().collection !== props.collection}>
            <p class="mg-review__idx ui-text-2">
              {t("mongoLoud.review.otherCollection", { collection: d().collection, current: props.collection ?? "" })}
              <Button size="sm" variant="secondary" icon={ArrowRight} onClick={() => props.onOpenCollection?.(d().collection)}>{t("mongoLoud.review.openIn", { collection: d().collection })}</Button>
            </p>
          </Show>
          <Show when={d().indexSuggestion}>
            <p class="mg-review__idx ui-text-2">{t("mongoLoud.review.indexHint")} <code class="ui-mono ui-selectable">{d().indexSuggestion}</code></p>
          </Show>
          <footer class="mg-review__actions">
            <Button size="sm" variant={armed() ? "danger" : "primary"} icon={Play} loading={props.m.status() === "loading"} onClick={run}>
              {armed() ? t("mongoLoud.review.confirmScan") : t("mongoLoud.review.run")}
            </Button>
            <Kbd keys={["⌘", "⇧", "↵"]} />
            <Button size="sm" variant="secondary" icon={Pencil} onClick={props.onEdit}>{t("mongoLoud.review.edit")}</Button>
            <Button size="sm" variant="ghost" icon={X} onClick={() => ai().discardDraft()}>{t("mongoLoud.review.discard")}</Button>
            <Show when={armed()}><span class="ui-text-2">{t("mongoLoud.review.scanWarning")}</span></Show>
          </footer>
        </section>
      )}
    </Show>
  );
}
