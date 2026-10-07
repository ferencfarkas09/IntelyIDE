import { createResource, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TabInstance } from "../../platform/tabs";
import { repoConfig } from "../../store/workspace";
import { Button, EmptyState, History, Skeleton } from "../../ui-kit";
import { openCommitFile } from "./openers";
import { fullDate, listDate, shortOid } from "./format";
import { Refs } from "./Refs";
import "./graph.css";

interface HistoryParams extends Record<string, unknown> {
  repoId: string;
  path: string;
}

/** Tab type `filehistory`: the commits that touched one file, newest first; a row opens that commit's diff of the file. */
export default function HistoryTab(props: { tab: TabInstance }) {
  const p = () => props.tab.params as HistoryParams;
  const [rows, { refetch }] = createResource(
    () => ({ ...p() }),
    (r) => ipc.graph.fileHistory(r.repoId, r.path),
  );
  return (
    <section class="ghistory" aria-label={t("graph.history.label", { path: p().path })}>
      <header class="ghistory__head">
        <span class="ghistory__repo" style={{ "--repo": repoConfig(p().repoId)?.color }}>{repoConfig(p().repoId)?.name ?? p().repoId}</span>
        <span class="ghistory__path ui-truncate" title={p().path}>{p().path}</span>
      </header>
      <Show when={!rows.error} fallback={<EmptyState tone="danger" size="sm" title={t("graph.history.failed")} description={(rows.error as { message?: string }).message} action={<Button size="sm" onClick={() => void refetch()}>{t("graph.retry")}</Button>} />}>
        <Show when={rows()} fallback={<div class="ghunks__loading" aria-busy="true"><Skeleton height={14} width="70%" /><Skeleton height={14} width="55%" /><Skeleton height={14} width="64%" /></div>}>
          {(list) => (
            <Show when={list().length > 0} fallback={<EmptyState size="sm" icon={History} title={t("graph.history.none")} description={t("graph.history.noneDesc")} />}>
              <ul class="ghistory__list">
                <For each={list()}>
                  {(row) => (
                    <li>
                      <button type="button" class="ghistory__row" onClick={() => openCommitFile(row.repoId, row.oid, { path: p().path })} title={t("graph.history.open", { path: p().path, oid: shortOid(row.oid) })}>
                        <code class="ui-mono ghistory__oid">{shortOid(row.oid)}</code>
                        <Refs decorations={row.decorations} max={2} />
                        <span class="ghistory__subject ui-truncate">{row.subject}</span>
                        <span class="ghistory__author ui-truncate">{row.author}</span>
                        <span class="ghistory__date ui-tnum" title={fullDate(row.dateMs)}>{listDate(row.dateMs)}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </Show>
    </section>
  );
}
