import { For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, Button, EmptyState, Layers, RefreshCw, Skeleton } from "../../ui-kit";
import { webtoolsApi } from "./api";
import { duplicateColorPrompt, hardcodedPrompt, quotable, unusedTokensPrompt } from "./logic";
import { AskButton, ConfBadge, createLoad, FileLink, Swatch } from "./shared";
import type { Token, TokenKind } from "./types";

const KIND: Record<TokenKind, "webtools.tokens.kind.custom" | "webtools.tokens.kind.scss" | "webtools.tokens.kind.scssMap" | "webtools.tokens.kind.less"> = {
  custom: "webtools.tokens.kind.custom",
  scss: "webtools.tokens.kind.scss",
  scssMap: "webtools.tokens.kind.scssMap",
  less: "webtools.tokens.kind.less",
};

export default function TokensPanel(props: { repoId: string }) {
  const load = createLoad(() => webtoolsApi().tokens(props.repoId));
  onMount(() => void load.run());
  const unused = () => (load.data()?.tokens ?? []).filter((x) => x.unused);
  return (
    <div class="wt__panel" data-testid="wt-tokens">
      <header class="wt__phead">
        <h3 class="wt__h">{t("webtools.tokens.title")}</h3>
        <span class="wt__spacer" />
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={load.loading()} onClick={() => void load.run()}>
          {t("webtools.refresh")}
        </Button>
      </header>
      <p class="wt__hint">{t("webtools.tokens.intro")}</p>
      <Show when={load.error()}>
        <p class="wt__error" role="alert">{load.error()}</p>
      </Show>
      <Show when={load.data()} fallback={<Show when={!load.error()}><Skeleton height={22} /></Show>}>
        {(r) => (
          <>
            <Show when={r().tokens.length === 0}>
              <EmptyState icon={Layers} size="sm" title={t("webtools.tokens.none")} description={t("webtools.tokens.noneDesc")} />
            </Show>
            <Show when={r().swatches.length > 0}>
              <section class="wt__sec" aria-label={t("webtools.tokens.swatches")}>
                <h4 class="wt__h2">{t("webtools.tokens.swatches")}</h4>
                <ul class="wt__swatches">
                  <For each={r().swatches}>
                    {(s) => (
                      <li class="wt__sw" title={`${s.name}: ${s.value}`}>
                        <Swatch value={s.value} name={s.name} />
                        <code>{s.name}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <Show when={r().tokens.length > 0}>
              <section class="wt__sec" aria-label={t("webtools.tokens.list")}>
                <h4 class="wt__h2">{t("webtools.tokens.list")} <Badge size="sm" numeric>{r().tokens.length}</Badge></h4>
                <ul class="wt__rows">
                  <For each={r().tokens}>{(tok) => <TokenRow repoId={props.repoId} tok={tok} />}</For>
                </ul>
              </section>
            </Show>
            <Show when={unused().length > 0}>
              <section class="wt__sec" aria-label={t("webtools.tokens.unused")}>
                <h4 class="wt__h2">{t("webtools.tokens.unused")} <Badge size="sm" tone="warn" numeric>{unused().length}</Badge></h4>
                <p class="wt__why">{t("webtools.tokens.unusedWhy")}</p>
                <Show when={r().dynamicNames}>
                  <p class="wt__note">{t("webtools.tokens.dynamic")}</p>
                </Show>
                <AskButton repoId={props.repoId} aria={t("webtools.tokens.askUnusedAria")} label={t("webtools.tokens.askUnused")} prompt={() => unusedTokensPrompt(unused())} />
              </section>
            </Show>
            <Show when={r().hardcoded.length > 0}>
              <section class="wt__sec" aria-label={t("webtools.tokens.hardcoded")}>
                <h4 class="wt__h2">{t("webtools.tokens.hardcoded")} <Badge size="sm" tone="info" numeric>{r().hardcoded.length}</Badge></h4>
                <p class="wt__why">{t("webtools.tokens.hardcodedWhy")}</p>
                <ul class="wt__rows">
                  <For each={r().hardcoded.slice(0, 60)}>
                    {(h) => (
                      <li class="wt__row">
                        <FileLink repoId={props.repoId} path={h.file} line={h.line} />
                        <code class="wt__code">{h.prop}: {h.value}</code>
                        <span class="wt__hint">{t("webtools.tokens.couldUse", { token: h.suggestion })}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <AskButton repoId={props.repoId} aria={t("webtools.tokens.askHardcodedAria")} label={t("webtools.tokens.askHardcoded")} prompt={() => hardcodedPrompt(r().hardcoded)} />
              </section>
            </Show>
            <Show when={r().duplicates.length > 0}>
              <section class="wt__sec" aria-label={t("webtools.tokens.duplicates")}>
                <h4 class="wt__h2">{t("webtools.tokens.duplicates")} <Badge size="sm" tone="info" numeric>{r().duplicates.length}</Badge></h4>
                <p class="wt__why">{t("webtools.tokens.duplicatesWhy")}</p>
                <ul class="wt__rows">
                  <For each={r().duplicates}>
                    {(d) => (
                      <li class="wt__row">
                        <Swatch value={d.swatch} name={d.value} />
                        <code>{d.value}</code>
                        <span class="wt__hint">{d.tokens.length ? t("webtools.tokens.dupTokens", { names: d.tokens.join(", ") }) : t("webtools.tokens.dupHand", { count: d.hardcoded })}</span>
                        <span class="wt__spacer" />
                        <AskButton repoId={props.repoId} size="sm" variant="ghost" aria={t("webtools.tokens.askDupAria", { value: d.value })} prompt={() => duplicateColorPrompt(d)} />
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <For each={r().skipped}>{(s) => <p class="wt__note">{s}</p>}</For>
          </>
        )}
      </Show>
    </div>
  );
}

function TokenRow(props: { repoId: string; tok: Token }) {
  const tok = () => props.tok;
  return (
    <li class="wt__row" data-unused={tok().unused ? "" : undefined}>
      <Swatch value={tok().swatch} name={tok().name} />
      <code class="wt__name">{tok().name}</code>
      <Show when={quotable(tok().value) || tok().kind === "scssMap"}>
        <code class="wt__val">{tok().value}</code>
      </Show>
      <Badge size="sm">{t(KIND[tok().kind])}</Badge>
      <span class="wt__hint">{t("webtools.tokens.uses", { count: tok().uses })}</span>
      <Show when={tok().definitions > 1}>
        <span class="wt__hint">{t("webtools.tokens.defs", { count: tok().definitions })}</span>
      </Show>
      <Show when={tok().unused}>
        <Badge size="sm" tone="warn">{t("webtools.tokens.unusedBadge")}</Badge>
        <ConfBadge value={tok().confidence} />
      </Show>
      <span class="wt__spacer" />
      <FileLink repoId={props.repoId} path={tok().file} line={tok().line} />
    </li>
  );
}
