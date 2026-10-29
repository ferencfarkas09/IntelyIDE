import { For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, ListTree, Button, EmptyState, RefreshCw, Skeleton } from "../../ui-kit";
import { webtoolsApi } from "./api";
import { unusedStylesPrompt } from "./logic";
import { AskButton, ConfBadge, createLoad, FileLink } from "./shared";

export default function StylesPanel(props: { repoId: string }) {
  const load = createLoad(() => webtoolsApi().unusedStyles(props.repoId));
  onMount(() => void load.run());
  return (
    <div class="wt__panel" data-testid="wt-styles">
      <header class="wt__phead">
        <h3 class="wt__h">{t("webtools.styles.title")}</h3>
        <Badge size="sm" tone="info">{t("webtools.heuristic")}</Badge>
        <span class="wt__spacer" />
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={load.loading()} onClick={() => void load.run()}>
          {t("webtools.refresh")}
        </Button>
      </header>
      <p class="wt__hint">{t("webtools.styles.intro")}</p>
      <Show when={load.error()}>
        <p class="wt__error" role="alert">{load.error()}</p>
      </Show>
      <Show when={load.data()} fallback={<Show when={!load.error()}><Skeleton height={22} /></Show>}>
        {(r) => (
          <>
            <p class="wt__hint">{t("webtools.styles.summary", { checked: r().classesChecked, files: r().filesScanned })}</p>
            <Show when={r().dynamicClasses}>
              <p class="wt__note">{t("webtools.styles.dynamicNote")}</p>
            </Show>
            <Show when={r().files.length === 0}>
              <EmptyState icon={ListTree} size="sm" title={t("webtools.styles.none")} description={t("webtools.styles.noneDesc")} />
            </Show>
            <For each={r().files}>
              {(file) => (
                <section class="wt__sec" aria-label={file.path}>
                  <header class="wt__phead">
                    <FileLink repoId={props.repoId} path={file.path} />
                    <Show when={file.module}>
                      <Badge size="sm">{t("webtools.styles.module")}</Badge>
                    </Show>
                    <Show when={file.notImported}>
                      <Badge size="sm" tone="warn">{t("webtools.styles.notImported")}</Badge>
                    </Show>
                    <span class="wt__spacer" />
                    <AskButton repoId={props.repoId} aria={t("webtools.styles.askAria", { file: file.path })} prompt={() => unusedStylesPrompt(file)} />
                  </header>
                  <ul class="wt__rows">
                    <For each={file.classes}>
                      {(c) => (
                        <li class="wt__row">
                          <code class="wt__name">.{c.name}</code>
                          <FileLink repoId={props.repoId} path={file.path} line={c.line} class="wt__line" />
                          <Badge size="sm" tone={c.status === "dynamic" ? "info" : "warn"}>{c.status === "dynamic" ? t("webtools.styles.dynamic") : t("webtools.styles.unused")}</Badge>
                          <ConfBadge value={c.confidence} />
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
            <p class="wt__hint">{t("webtools.styles.neverDeletes")}</p>
            <For each={r().skipped}>{(s) => <p class="wt__note">{s}</p>}</For>
          </>
        )}
      </Show>
    </div>
  );
}
