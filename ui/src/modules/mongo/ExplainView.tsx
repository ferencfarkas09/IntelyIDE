import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, Button, CircleAlert, CircleCheck, EmptyState, Gauge, Skeleton, Sparkles, TriangleAlert } from "../../ui-kit";
import { stageVerdict } from "./logic";
import type { CollectionModel } from "./model";

/** Explain: the winning plan as a chain of stages with a verdict each, counts in tabular numbers, and the raw document. */
export function ExplainView(props: { m: CollectionModel; estimated?: number }) {
  const m = () => props.m;
  const [raw, setRaw] = createSignal(false);
  const r = () => m().explainResult();
  const ratio = () => {
    const p = r()?.plan;
    return p?.docsExamined != null && p.nReturned ? Math.round((p.docsExamined / Math.max(p.nReturned, 1)) * 10) / 10 : undefined;
  };
  return (
    <div class="mg-explain">
      <div class="mg-explain__bar">
        <Button size="sm" variant="secondary" icon={Gauge} loading={m().explainStatus() === "loading"} onClick={() => void m().explain(false)}>{t("mongoStudio.explain.run")}</Button>
        <Button size="sm" variant="ghost" disabled={!r()} onClick={() => void m().explain(true)} title={t("mongoStudio.explain.withStatsHint")}>{t("mongoStudio.explain.withStats")}</Button>
        <Show when={m().ai.allowed() && r()}>
          <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => void m().ai.explainInWords()}>{t("mongoStudio.explain.inWords")}</Button>
        </Show>
        <Show when={r()}>
          <Button size="sm" variant="ghost" onClick={() => setRaw(!raw())}>{raw() ? t("mongoStudio.explain.summary") : t("mongoStudio.explain.raw")}</Button>
        </Show>
      </div>
      <Show when={m().explainStatus() === "loading" && !r()}><div class="mg-explain__pad"><Skeleton height={64} /></div></Show>
      <Show when={m().explainStatus() === "error"}>
        <EmptyState tone="danger" size="sm" icon={CircleAlert} title={m().explainError()?.title ?? t("mongoStudio.explain.failed")} description={m().explainError()?.detail} action={<Button size="sm" onClick={() => void m().explain(false)}>{t("mongoStudio.explain.retry")}</Button>} />
      </Show>
      <Show when={!r() && m().explainStatus() === "idle"}>
        <EmptyState size="sm" icon={Gauge} title={t("mongoStudio.explain.emptyTitle")} description={t("mongoStudio.explain.emptyDesc")} />
      </Show>
      <Show when={r()}>
        {(res) => (
          <Show when={!raw()} fallback={<pre class="mg-json ui-mono ui-selectable" tabIndex={0} aria-label={t("mongoStudio.explain.rawLabel")}>{res().raw}</pre>}>
            <div class="mg-explain__body">
              <ol class="mg-plan" aria-label={t("mongoStudio.explain.planLabel")}>
                <For each={res().plan.stages}>
                  {(s) => {
                    const v = stageVerdict(s, props.estimated);
                    return (
                      <li class="mg-plan__stage" data-tone={v.tone}>
                        <span class="mg-plan__name ui-mono">{s}</span>
                        <Badge size="sm" tone={v.tone} icon={v.tone === "ok" ? CircleCheck : TriangleAlert}>{v.text}</Badge>
                      </li>
                    );
                  }}
                </For>
              </ol>
              <dl class="mg-explain__facts">
                <div><dt>{t("mongoStudio.explain.index")}</dt><dd class="ui-mono">{res().plan.indexNames.join(", ") || t("mongoStudio.explain.none")}</dd></div>
                <div><dt>{t("mongoStudio.explain.engine")}</dt><dd>{res().plan.engine}</dd></div>
                <div><dt>{t("mongoStudio.explain.rejected")}</dt><dd class="ui-tnum">{res().plan.rejectedPlans}</dd></div>
                <Show when={res().stats}>
                  <div><dt>{t("mongoStudio.explain.keys")}</dt><dd class="ui-tnum">{(res().plan.keysExamined ?? 0).toLocaleString("en-US")}</dd></div>
                  <div><dt>{t("mongoStudio.explain.docs")}</dt><dd class="ui-tnum">{(res().plan.docsExamined ?? 0).toLocaleString("en-US")}</dd></div>
                  <div><dt>{t("mongoStudio.explain.returned")}</dt><dd class="ui-tnum">{(res().plan.nReturned ?? 0).toLocaleString("en-US")}</dd></div>
                  <Show when={ratio() !== undefined}><div><dt>{t("mongoStudio.explain.ratio")}</dt><dd class="ui-tnum">{ratio()}</dd></div></Show>
                  <div><dt>{t("mongoStudio.explain.time")}</dt><dd class="ui-tnum">{t("mongoStudio.explain.ms", { ms: res().elapsedMs })}</dd></div>
                </Show>
              </dl>
              <For each={res().plan.warnings}>{(w) => <p class="mg-ai__note" data-tone="warn"><TriangleAlert size={14} /> <span>{w}</span></p>}</For>
              <Show when={m().explainText()}><p class="mg-ai__note"><Sparkles size={14} /> <span>{m().explainText()}</span></p></Show>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}
