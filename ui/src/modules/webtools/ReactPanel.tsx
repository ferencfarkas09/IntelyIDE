import { createSignal, For, onMount, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { Badge, Button, CircleCheck, EmptyState, Input, RefreshCw, Skeleton } from "../../ui-kit";
import { webtoolsApi } from "./api";
import { groupByRule, reactBatchPrompt, reactFindingPrompt } from "./logic";
import { AskButton, ConfBadge, createLoad, FileLink } from "./shared";
import type { ReactRule } from "./types";

const TITLE: Record<ReactRule, MessageKey> = {
  imgAlt: "webtools.react.imgAlt.title",
  noAccessibleName: "webtools.react.noAccessibleName.title",
  inputLabel: "webtools.react.inputLabel.title",
  clickNonInteractive: "webtools.react.clickNonInteractive.title",
  listKey: "webtools.react.listKey.title",
  fragmentKey: "webtools.react.fragmentKey.title",
  largeComponent: "webtools.react.largeComponent.title",
  manyProps: "webtools.react.manyProps.title",
};
const WHY: Record<ReactRule, MessageKey> = {
  imgAlt: "webtools.react.imgAlt.why",
  noAccessibleName: "webtools.react.noAccessibleName.why",
  inputLabel: "webtools.react.inputLabel.why",
  clickNonInteractive: "webtools.react.clickNonInteractive.why",
  listKey: "webtools.react.listKey.why",
  fragmentKey: "webtools.react.fragmentKey.why",
  largeComponent: "webtools.react.largeComponent.why",
  manyProps: "webtools.react.manyProps.why",
};

const num = (s: string, fallback: number): number => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export default function ReactPanel(props: { repoId: string }) {
  const [maxLines, setMaxLines] = createSignal("200");
  const [maxProps, setMaxProps] = createSignal("10");
  const load = createLoad(() => webtoolsApi().react(props.repoId, { maxLines: num(maxLines(), 200), maxProps: num(maxProps(), 10) }));
  onMount(() => void load.run());
  return (
    <div class="wt__panel" data-testid="wt-react">
      <header class="wt__phead">
        <h3 class="wt__h">{t("webtools.react.title")}</h3>
        <Badge size="sm" tone="info" title={t("webtools.react.heuristicTip")}>{t("webtools.heuristic")}</Badge>
        <span class="wt__spacer" />
        <label class="wt__field">
          <span class="wt__hint">{t("webtools.react.maxLines")}</span>
          <Input size="sm" wrapperClass="wt__num" inputMode="numeric" aria-label={t("webtools.react.maxLines")} value={maxLines()} onInput={(e) => setMaxLines(e.currentTarget.value)} />
        </label>
        <label class="wt__field">
          <span class="wt__hint">{t("webtools.react.maxProps")}</span>
          <Input size="sm" wrapperClass="wt__num" inputMode="numeric" aria-label={t("webtools.react.maxProps")} value={maxProps()} onInput={(e) => setMaxProps(e.currentTarget.value)} />
        </label>
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={load.loading()} onClick={() => void load.run()}>
          {t("webtools.refresh")}
        </Button>
      </header>
      <p class="wt__hint">{t("webtools.react.intro")}</p>
      <Show when={load.error()}>
        <p class="wt__error" role="alert">{load.error()}</p>
      </Show>
      <Show when={load.data()} fallback={<Show when={!load.error()}><Skeleton height={22} /></Show>}>
        {(r) => (
          <>
            <Show when={r().findings.length === 0}>
              <EmptyState icon={CircleCheck} size="sm" title={t("webtools.react.none")} description={t("webtools.react.noneDesc", { files: r().filesScanned })} />
            </Show>
            <For each={groupByRule(r().findings)}>
              {(g) => (
                <section class="wt__sec" aria-label={t(TITLE[g.rule])}>
                  <header class="wt__phead">
                    <h4 class="wt__h2">{t(TITLE[g.rule])} <Badge size="sm" tone="warn" numeric>{g.items.length}</Badge></h4>
                    <span class="wt__spacer" />
                    <Show when={g.items.length > 1}>
                      <AskButton repoId={props.repoId} aria={t("webtools.react.askAllAria", { rule: t(TITLE[g.rule]) })} label={t("webtools.react.askAll")} prompt={() => reactBatchPrompt(g.rule, g.items)} />
                    </Show>
                  </header>
                  <p class="wt__why">{t(WHY[g.rule])}</p>
                  <ul class="wt__rows">
                    <For each={g.items}>
                      {(f) => (
                        <li class="wt__row">
                          <FileLink repoId={props.repoId} path={f.file} line={f.line} />
                          <code class="wt__code">{f.rule === "largeComponent" ? t("webtools.react.lines", { name: f.detail, count: f.count }) : f.rule === "manyProps" ? t("webtools.react.props", { name: f.detail, count: f.count }) : `<${f.detail}>`}</code>
                          <ConfBadge value={f.confidence} />
                          <span class="wt__spacer" />
                          <AskButton repoId={props.repoId} variant="ghost" aria={t("webtools.react.askAria", { file: f.file, line: f.line })} prompt={() => reactFindingPrompt(f)} />
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
            <For each={r().skipped}>{(s) => <p class="wt__note">{s}</p>}</For>
          </>
        )}
      </Show>
    </div>
  );
}
