import { createSignal, For, Show } from "solid-js";
import type { AgentRow } from "../../store/agents";
import type { RunStatus } from "../../store/agent-types";
import { closedRuns, closeRuns, reopenRuns } from "../../modules/runs/closed";
import { isClosed, previewRows } from "../../modules/runs/sessionsLogic";
import { Badge, Bot, ChevronDown, ChevronRight, EmptyState, Icon, IconButton, ScrollArea, StatusDot, toast, Tree, TreeRow, Undo2, X } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { modelLabel } from "./format";
import { effectiveMode } from "./modes";
import { StartingTreeRow } from "./Starting";
import type { StartingRun } from "../../store/starting";

const GROUPS: { status: RunStatus[]; title: MessageKey }[] = [
  { status: ["needsYou"], title: "chat.group.needsYou" },
  { status: ["running"], title: "chat.group.running" },
  { status: ["done", "error"], title: "chat.group.done" },
];
const TONE = { running: "accent", needsYou: "warn", done: "ok", error: "danger" } as const;
const LABEL = { running: "chat.group.running", needsYou: "chat.group.needsYou", done: "chat.group.done", error: "chat.group.failed" } as const satisfies Record<RunStatus, MessageKey>;

export function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  return min < 1 ? t("chat.ago.now") : min < 60 ? t("chat.ago.min", { n: min }) : t("chat.ago.hour", { n: Math.round(min / 60) });
}

export function AgentList(props: { rows: AgentRow[]; onSelect: (id: string) => void; selected?: string | null; starting?: StartingRun[]; startingFront?: string | null; onSelectStarting?: (key: string) => void }) {
  const [showClosed, setShowClosed] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [folded, setFolded] = createSignal(false);
  const closedN = () => props.rows.filter((r) => isClosed(r, closedRuns())).length;
  const listed = () => (showClosed() ? props.rows : props.rows.filter((r) => !isClosed(r, closedRuns())));
  const closeGroup = (rows: readonly AgentRow[]) => {
    const ids = rows.filter((r) => !isClosed(r, closedRuns())).map((r) => r.agentId);
    if (ids.length === 0) return;
    closeRuns(ids);
    toast.show({ title: t("runs.closed.toast", { count: ids.length }), description: t("runs.closed.toastDesc"), duration: 8000, action: { label: t("runs.closed.undo"), onSelect: () => reopenRuns(ids) } });
  };
  return (
    <Show when={listed().length > 0 || (props.starting?.length ?? 0) > 0 || closedN() > 0} fallback={<EmptyState icon={Bot} title={t("chat.noRuns")} description={t("chat.noRunsDesc")} />}>
      <ScrollArea class="runs">
        <div class="runs__inner">
          <Show when={(props.starting?.length ?? 0) > 0}>
            <section class="runs__group" aria-label={t("runs.starting.group")}>
              <h3 class="runs__title">
                {t("runs.starting.group")} <Badge numeric size="sm">{props.starting!.length}</Badge>
              </h3>
              <Tree aria-label={t("runs.starting.group")}>
                <For each={props.starting}>{(run) => <StartingTreeRow run={run} selected={props.startingFront === run.key} onSelect={() => props.onSelectStarting?.(run.key)} />}</For>
              </Tree>
            </section>
          </Show>
          <For each={GROUPS}>
            {(g) => {
              const rows = () => listed().filter((r) => g.status.includes(r.status));
              const finished = g.status.includes("done");
              const isFolded = () => finished && folded();
              const preview = () => previewRows(rows(), "done", !finished || expanded());
              return (
                <Show when={rows().length > 0}>
                  <section class="runs__group" aria-label={t(g.title)}>
                    <div class="runs__head">
                      <h3 class="runs__title">
                        <Show
                          when={finished}
                          fallback={
                            <>
                              {t(g.title)} <Badge numeric size="sm">{rows().length}</Badge>
                            </>
                          }
                        >
                          <button type="button" class="runs__toggle" aria-expanded={!isFolded()} title={isFolded() ? t("runs.group.expand", { title: t(g.title) }) : t("runs.group.collapse", { title: t(g.title) })} onClick={() => setFolded(!folded())}>
                            <Icon icon={isFolded() ? ChevronRight : ChevronDown} size={12} />
                            {t(g.title)} <Badge numeric size="sm">{rows().length}</Badge>
                          </button>
                        </Show>
                      </h3>
                      <Show when={finished && rows().some((r) => !isClosed(r, closedRuns()))}>
                        <IconButton class="runs__close-all" size="sm" icon={X} label={t("runs.closed.closeAll", { title: t(g.title) })} tooltip={t("runs.closed.closeAllTip")} onClick={() => closeGroup(rows())} />
                      </Show>
                    </div>
                    <Show when={!isFolded()}>
                      <Tree aria-label={t(g.title)}>
                        <For each={preview().shown}>
                          {(r) => {
                            const closed = () => isClosed(r, closedRuns());
                            return (
                              <TreeRow
                                selected={props.selected === r.agentId}
                                leading={<StatusDot tone={TONE[r.status]} label={t(LABEL[r.status])} />}
                                trailing={
                                  <span class="runs__meta ui-tnum">
                                    <Show when={effectiveMode(r) === "bypass"}>
                                      <Badge tone="danger" variant="solid" size="sm" title={t("modes.header.bypassTip")}>
                                        {t("modes.header.bypassChip")}
                                      </Badge>{" "}
                                    </Show>
                                    {r.role} · {ago(r.startedAt)}
                                  </span>
                                }
                                actions={
                                  finished ? <IconButton size="sm" icon={closed() ? Undo2 : X} label={closed() ? t("runs.closed.reopen") : t("runs.closed.close")} onClick={(e) => (e.stopPropagation(), closed() ? reopenRuns([r.agentId]) : closeRuns([r.agentId]))} /> : undefined
                                }
                                onClick={() => props.onSelect(r.agentId)}
                                onKeyDown={(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onSelect(r.agentId))}
                                tabbable
                                class="runs__row"
                                data-closed={closed() ? "" : undefined}
                                title={`${r.title} (${modelLabel(r.model)})`}
                              >
                                <span class="ui-truncate">{r.title}</span>
                              </TreeRow>
                            );
                          }}
                        </For>
                      </Tree>
                      <Show when={finished && (preview().hidden > 0 || expanded())}>
                        <button type="button" class="runs__more" onClick={() => setExpanded(!expanded())}>
                          {expanded() ? t("runs.group.fewer") : t("runs.group.more", { count: preview().hidden })}
                        </button>
                      </Show>
                    </Show>
                  </section>
                </Show>
              );
            }}
          </For>
          <Show when={closedN() > 0 || showClosed()}>
            <button type="button" class="runs__closed" aria-pressed={showClosed()} onClick={() => setShowClosed(!showClosed())}>
              {showClosed() ? t("runs.closed.hide") : t("runs.closed.show", { count: closedN() })}
            </button>
          </Show>
        </div>
      </ScrollArea>
    </Show>
  );
}
