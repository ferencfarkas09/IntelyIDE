import { For, Show, type JSX } from "solid-js";
import { costLabel, fmtTokens, modelLabel, PERMISSION_LABEL, TIER_LABEL, TIER_TITLE, TIER_TONE } from "../../components/chat/format";
import { t } from "../../i18n";
import { agentRow, agentView, selectedAgentId } from "../../store/agents";
import type { PermissionMode } from "../../store/agent-types";
import { repoConfig } from "../../store/workspace";
import { Badge, Bot, EmptyState, ScrollArea } from "../../ui-kit";

function Fact(props: { label: string; children: JSX.Element; title?: string }) {
  return (
    <div class="facts__row" title={props.title}>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** Inspector tab: what the selected run was asked to do, what the provider actually applied, and what it cost. */
export default function RunSummaryPanel() {
  const row = () => agentRow(selectedAgentId());
  const view = () => (row() ? agentView(row()!.agentId) : undefined);
  return (
    <Show when={row()} fallback={<EmptyState icon={Bot} size="sm" title={t("runs.summary.none")} description={t("runs.summary.noneDesc")} />}>
      {(r) => {
        const cost = () => costLabel(r().usage, r().caps.usage ?? { cap: "no" });
        const applied = () => view()?.session?.effective;
        const differs = (requested: string | null | undefined, effective: string | null | undefined) => !!effective && !!requested && requested !== effective;
        return (
          <ScrollArea class="facts__scroll">
            <dl class="facts">
              <Fact label={t("runs.role")}>{r().role}</Fact>
              <Fact label={t("runs.provider")}>{r().provider}</Fact>
              <Fact label={t("runs.summary.model")}>{modelLabel(view()?.session?.model ?? r().model)}</Fact>
              <Fact label={t("runs.summary.effort")} title={t("runs.summary.effortTip")}>
                {r().requested.effort ?? t("runs.na")}
                <Show when={differs(r().requested.effort, applied()?.effort)}>
                  <Badge tone="warn" size="sm" title={t("runs.summary.effortDiff")}>
                    {t("runs.summary.applied", { value: String(applied()?.effort) })}
                  </Badge>
                </Show>
              </Fact>
              <Fact label={t("runs.summary.permission")}>
                {PERMISSION_LABEL[r().requested.permission]}
                <Show when={differs(r().requested.permission, applied()?.permission)}>
                  <Badge tone="warn" size="sm" title={t("runs.summary.permissionDiff")}>
                    {t("runs.summary.applied", { value: PERMISSION_LABEL[applied()!.permission as PermissionMode] ?? String(applied()?.permission) })}
                  </Badge>
                </Show>
              </Fact>
              <Fact label={t("runs.summary.sandbox")}>{applied()?.sandbox ?? r().effective?.sandbox ?? t("runs.na")}</Fact>
              <Fact label={t("runs.summary.enforcement")} title={TIER_TITLE[r().enforcement]}>
                <Badge tone={TIER_TONE[r().enforcement]} variant="outline" size="sm">
                  {TIER_LABEL[r().enforcement]}
                </Badge>
              </Fact>
              <Fact label={t("runs.summary.cost")} title={cost().title}>
                <span class="ui-tnum">{cost().text}</span>
              </Fact>
              <Show when={r().usage}>
                {(u) => (
                  <Fact label={t("runs.summary.tokens")}>
                    <span class="ui-tnum">
                      {t("inspector.stat.tokensValue", { input: fmtTokens(u().cumulative.inputTokens), output: fmtTokens(u().cumulative.outputTokens) })}
                    </span>
                  </Fact>
                )}
              </Show>
              <Fact label={t("runs.repos")}>
                <For each={r().repoIds}>{(id, i) => <>{i() > 0 ? ", " : ""}{repoConfig(id)?.name ?? id}</>}</For>
              </Fact>
            </dl>
          </ScrollArea>
        );
      }}
    </Show>
  );
}
