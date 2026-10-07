import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import type { TabInstance } from "../../platform/tabs";
import { Badge, EmptyState, ExternalLink, Icon, IconButton, Plug, RefreshCw, SegmentedControl, Skeleton, Check, Search, Input } from "../../ui-kit";
import { openHit } from "../search/openHit";
import Explorer from "./Explorer";
import Findings, { repoName } from "./Findings";
import { filterUnused } from "./logic";
import { analyzeError, analyzing, refresh, report } from "./store";
import type { Report } from "./types";
import { For } from "solid-js";
import "./contract.css";

type View = "findings" | "explorer" | "unused";

function Unused(props: { report: Report }) {
  const [text, setText] = createSignal("");
  const list = createMemo(() => filterUnused(props.report.unused, text()));
  return (
    <div class="contract__unused">
      <p class="contract__hint">{t("contract.unused.note")}</p>
      <Input size="sm" aria-label={t("contract.explorer.search")} placeholder={t("contract.explorer.search")} leading={<Search size={14} aria-hidden="true" />} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      <Show when={props.report.unused.length} fallback={<EmptyState icon={Check} size="sm" title={t("contract.unused.none")} description={t("contract.unused.noneDesc")} />}>
        <ul class="contract__list" aria-label={t("contract.unused.title")}>
          <For each={list().rows}>
            {(u) => (
              <li class="contract__finding contract__urow" data-testid="contract-unused">
                <span class="contract__method" data-method={u.method}>
                  {u.method}
                </span>
                <code class="contract__target">{u.path}</code>
                <Show when={u.operationId}>
                  <code class="contract__chip">{u.operationId}</code>
                </Show>
                <span class="contract__spacer" />
                <IconButton icon={ExternalLink} size="sm" label={t("contract.openSwagger")} onClick={() => openHit(props.report.spec.repoId, u.source.file, u.source.line, 1)} />
              </li>
            )}
          </For>
        </ul>
        <Show when={list().total > list().rows.length}>
          <p class="contract__hint">{t("contract.unused.shown", { shown: fmt.number(list().rows.length), total: fmt.number(list().total) })}</p>
        </Show>
      </Show>
    </div>
  );
}

/** The API contract tab: detector findings per repo, the swagger explorer and the endpoints no client calls. */
export default function ContractTab(props: { tab: TabInstance }) {
  const [view, setView] = createSignal<View>((props.tab.params?.view as View | undefined) ?? "findings");
  createEffect(on(() => 1, () => void refresh()));
  const r = () => report();
  return (
    <div class="contract" data-testid="contract-tab">
      <header class="contract__bar">
        <Icon icon={Plug} size={16} />
        <h2 class="contract__title">{t("contract.name")}</h2>
        <SegmentedControl
          size="sm"
          aria-label={t("contract.view")}
          value={view()}
          onChange={setView}
          options={[
            { value: "findings", label: t("contract.view.findings") },
            { value: "explorer", label: t("contract.view.explorer") },
            { value: "unused", label: t("contract.view.unused") },
          ]}
        />
        <span class="contract__spacer" />
        <Show when={r()}>
          {(rep) => (
            <For each={rep().clients}>
              {(c) => (
                <Badge size="sm" tone={c.cached ? "neutral" : "info"} title={c.cached ? t("contract.cachedTip") : c.fingerprint}>
                  {repoName(c.repoId)}: {t("contract.clientLine", { calls: c.counts.calls, files: c.counts.files })}
                  {c.cached ? ` · ${t("contract.cached")}` : ""}
                </Badge>
              )}
            </For>
          )}
        </Show>
        <IconButton icon={RefreshCw} label={t("contract.checkAgain")} size="sm" loading={analyzing()} onClick={() => void refresh()} />
      </header>
      <p class="contract__note" role="note">
        {t("contract.heuristic")}
      </p>
      <Show when={analyzeError()}>
        <p class="contract__error" role="alert">
          {analyzeError()}
        </p>
      </Show>
      <Show
        when={r()}
        fallback={
          <Show when={!analyzeError()}>
            <div class="contract__loading">
              <Skeleton height={20} />
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          </Show>
        }
      >
        {(rep) => (
          <>
            <p class="contract__hint" data-testid="contract-spec">
              {t("contract.specLine", { kind: rep().spec.kind, version: rep().spec.version, repo: repoName(rep().spec.repoId), endpoints: rep().spec.endpoints, definitions: rep().spec.definitions })}
            </p>
            <Show when={view() === "findings"}>
              <Findings report={rep()} />
            </Show>
            <Show when={view() === "explorer"}>
              <Explorer report={rep()} />
            </Show>
            <Show when={view() === "unused"}>
              <Unused report={rep()} />
            </Show>
          </>
        )}
      </Show>
      <Show when={!r() && analyzeError()}>
        <EmptyState icon={Plug} size="sm" title={t("contract.noSpec")} description={t("contract.noSpecDesc")} />
      </Show>
    </div>
  );
}
