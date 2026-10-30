import { For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, Button, CircleCheck, EmptyState, KeyRound, RefreshCw, Skeleton } from "../../ui-kit";
import { webtoolsApi } from "./api";
import { envPrompt } from "./logic";
import { AskButton, createLoad, FileLink } from "./shared";
import type { EnvDir } from "./types";

const clean = (d: EnvDir): boolean => d.missing.length === 0 && d.undocumented.length === 0 && !d.noExample && !d.noEnv && d.files.every((f) => f.example || (!f.unprotected && !f.tracked));

export default function EnvPanel(props: { repoId: string }) {
  const load = createLoad(() => webtoolsApi().env(props.repoId));
  onMount(() => void load.run());
  return (
    <div class="wt__panel" data-testid="wt-env">
      <header class="wt__phead">
        <h3 class="wt__h">{t("webtools.env.title")}</h3>
        <Badge size="sm" tone="ok" icon={KeyRound}>{t("webtools.env.namesOnly")}</Badge>
        <span class="wt__spacer" />
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={load.loading()} onClick={() => void load.run()}>
          {t("webtools.refresh")}
        </Button>
      </header>
      <p class="wt__hint">{t("webtools.env.intro")}</p>
      <Show when={load.error()}>
        <p class="wt__error" role="alert">{load.error()}</p>
      </Show>
      <Show when={load.data()} fallback={<Show when={!load.error()}><Skeleton height={22} /></Show>}>
        {(r) => (
          <>
            <Show when={r().dirs.length === 0}>
              <EmptyState icon={KeyRound} size="sm" title={t("webtools.env.none")} description={t("webtools.env.noneDesc")} />
            </Show>
            <For each={r().dirs}>
              {(d) => (
                <section class="wt__sec" aria-label={d.dir || t("webtools.env.root")}>
                  <header class="wt__phead">
                    <h4 class="wt__h2"><code>{d.dir || t("webtools.env.root")}</code></h4>
                    <Show when={clean(d)}>
                      <Badge size="sm" tone="ok" icon={CircleCheck}>{t("webtools.env.ok")}</Badge>
                    </Show>
                    <span class="wt__spacer" />
                    <Show when={!clean(d)}>
                      <AskButton repoId={props.repoId} aria={t("webtools.env.askAria", { dir: d.dir || t("webtools.env.root") })} prompt={() => envPrompt(d)} />
                    </Show>
                  </header>
                  <ul class="wt__rows">
                    <For each={d.files}>
                      {(f) => (
                        <li class="wt__row">
                          <FileLink repoId={props.repoId} path={f.path} />
                          <Badge size="sm" tone={f.example ? "info" : "neutral"}>{f.example ? t("webtools.env.example") : t("webtools.env.real")}</Badge>
                          <span class="wt__hint">{t("webtools.env.keys", { count: f.keys })}</span>
                          <Show when={f.unprotected}>
                            <Badge size="sm" tone="danger" title={t("webtools.env.unprotectedWhy")}>{t("webtools.env.unprotected")}</Badge>
                          </Show>
                          <Show when={f.tracked}>
                            <Badge size="sm" tone="danger" title={t("webtools.env.trackedWhy")}>{t("webtools.env.tracked")}</Badge>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={d.noEnv}>
                    <p class="wt__note">{t("webtools.env.noEnv")}</p>
                  </Show>
                  <Show when={d.noExample}>
                    <p class="wt__note">{t("webtools.env.noExample")}</p>
                  </Show>
                  <Show when={d.missing.length > 0}>
                    <p class="wt__why">{t("webtools.env.missingWhy")}</p>
                    <ul class="wt__chips" aria-label={t("webtools.env.missing")}>
                      <For each={d.missing}>{(m) => <li><code>{m.key}</code></li>}</For>
                    </ul>
                  </Show>
                  <Show when={d.undocumented.length > 0}>
                    <p class="wt__why">{t("webtools.env.undocumentedWhy")}</p>
                    <ul class="wt__chips" aria-label={t("webtools.env.undocumented")}>
                      <For each={d.undocumented}>{(k) => <li><code>{k}</code></li>}</For>
                    </ul>
                  </Show>
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
