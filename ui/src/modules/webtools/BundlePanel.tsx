import { For, onMount, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { Badge, Button, EmptyState, Gauge, RefreshCw, Skeleton } from "../../ui-kit";
import { webtoolsApi } from "./api";
import { bundlePrompt, fmtBytes } from "./logic";
import { AskButton, createLoad, FileLink } from "./shared";

export default function BundlePanel(props: { repoId: string }) {
  const load = createLoad(() => webtoolsApi().bundle(props.repoId));
  onMount(() => void load.run());
  return (
    <div class="wt__panel" data-testid="wt-bundle">
      <header class="wt__phead">
        <h3 class="wt__h">{t("webtools.bundle.title")}</h3>
        <span class="wt__spacer" />
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={load.loading()} onClick={() => void load.run()}>
          {t("webtools.refresh")}
        </Button>
      </header>
      <p class="wt__hint">{t("webtools.bundle.intro")}</p>
      <Show when={load.error()}>
        <p class="wt__error" role="alert">{load.error()}</p>
      </Show>
      <Show when={load.data()} fallback={<Show when={!load.error()}><Skeleton height={22} /></Show>}>
        {(r) => (
          <>
            <Show when={r().dirs.length === 0}>
              <EmptyState icon={Gauge} size="sm" title={t("webtools.bundle.none")} description={t("webtools.bundle.noneDesc")} />
            </Show>
            <For each={r().dirs}>
              {(d) => (
                <section class="wt__sec" aria-label={d.dir}>
                  <header class="wt__phead">
                    <h4 class="wt__h2"><code>{d.dir}</code></h4>
                    <Badge size="sm" numeric>{t("webtools.bundle.files", { count: d.files })}</Badge>
                    <span class="wt__spacer" />
                    <AskButton repoId={props.repoId} aria={t("webtools.bundle.askAria", { dir: d.dir })} label={t("webtools.bundle.ask")} prompt={() => bundlePrompt(d.dir, d.top, d.totalSize)} />
                  </header>
                  <p class="wt__stat">
                    <strong>{fmtBytes(d.totalSize)}</strong> <span class="wt__hint">{t("webtools.bundle.total")}</span>
                    <span class="wt__sep">·</span>
                    <strong>≈ {fmtBytes(d.totalGzipEstimate)}</strong> <span class="wt__hint" title={t("webtools.bundle.gzipTip")}>{t("webtools.bundle.gzip")}</span>
                  </p>
                  <Show when={d.newest > 0}>
                    <p class="wt__hint">{t("webtools.bundle.built", { when: fmt.relative(d.newest * 1000) })}</p>
                  </Show>
                  <ol class="wt__bars" aria-label={t("webtools.bundle.top")}>
                    <For each={d.top}>
                      {(a) => (
                        <li class="wt__asset">
                          <FileLink repoId={props.repoId} path={a.path} />
                          <span class="wt__barline" aria-hidden="true">
                            <span style={{ width: `${Math.max(2, Math.round((a.size / (d.top[0]?.size || 1)) * 100))}%` }} />
                          </span>
                          <span class="wt__size">{fmtBytes(a.size)}</span>
                          <Badge size="sm">{a.kind}</Badge>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={d.mapSize > 0}>
                    <p class="wt__hint">{t("webtools.bundle.maps", { size: fmtBytes(d.mapSize) })}</p>
                  </Show>
                </section>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  );
}
