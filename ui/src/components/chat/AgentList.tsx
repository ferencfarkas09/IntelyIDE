import { For, Show } from "solid-js";
import type { AgentRow } from "../../store/agents";
import type { RunStatus } from "../../store/agent-types";
import { Badge, Bot, EmptyState, ScrollArea, StatusDot, Tree, TreeRow } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { modelLabel } from "./format";
import { effectiveMode } from "./modes";

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

export function AgentList(props: { rows: AgentRow[]; onSelect: (id: string) => void; selected?: string | null }) {
  return (
    <Show when={props.rows.length > 0} fallback={<EmptyState icon={Bot} title={t("chat.noRuns")} description={t("chat.noRunsDesc")} />}>
      <ScrollArea class="runs">
        <div class="runs__inner">
          <For each={GROUPS}>
            {(g) => {
              const rows = () => props.rows.filter((r) => g.status.includes(r.status));
              return (
                <Show when={rows().length > 0}>
                  <section class="runs__group" aria-label={t(g.title)}>
                    <h3 class="runs__title">
                      {t(g.title)} <Badge numeric size="sm">{rows().length}</Badge>
                    </h3>
                    <Tree aria-label={t(g.title)}>
                      <For each={rows()}>
                        {(r) => (
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
                            onClick={() => props.onSelect(r.agentId)}
                            onKeyDown={(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onSelect(r.agentId))}
                            tabbable
                            class="runs__row"
                            title={`${r.title} (${modelLabel(r.model)})`}
                          >
                            <span class="ui-truncate">{r.title}</span>
                          </TreeRow>
                        )}
                      </For>
                    </Tree>
                  </section>
                </Show>
              );
            }}
          </For>
        </div>
      </ScrollArea>
    </Show>
  );
}
