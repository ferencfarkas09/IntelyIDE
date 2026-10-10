import { For, Show } from "solid-js";
import { ago } from "../../components/chat/AgentList";
import { costLabel, modelLabel, TIER_LABEL, TIER_TITLE, TIER_TONE } from "../../components/chat/format";
import { effectiveMode } from "../../components/chat/modes";
import { t, type MessageKey } from "../../i18n";
import type { AgentView } from "../../store/agent-reducer";
import type { AgentRow } from "../../store/agents";
import { foreignReason, isForeign } from "../../store/agentScope";
import { repoConfig } from "../../store/workspace";
import { LocationChip } from "../servers/LocationChip";
import { Badge, RepoBadge, ShieldCheck, StatusDot } from "../../ui-kit";
import { roleColor } from "./roleColors";
import { activityLine } from "./sessionsLogic";

const TONE = { running: "accent", needsYou: "warn", done: "ok", error: "danger" } as const;
const MAX_REPOS = 2;
const LABEL = { running: "runs.running", needsYou: "runs.needsYou", done: "runs.done", error: "runs.failed" } as const satisfies Record<AgentRow["status"], MessageKey>;

/** One run in the sessions list: live status, what it is doing, who runs it where, what it costs and how well it is fenced. */
export function RunCard(props: { row: AgentRow; view: AgentView | undefined; selected: boolean; onSelect: () => void }) {
  const r = () => props.row;
  const foreign = () => isForeign(r().repoIds);
  const cost = () => costLabel(r().usage, r().caps.usage ?? { cap: "no" });
  const status = () => (r().status === "running" && r().throttle ? { tone: "warn" as const, label: r().throttle!.state === "retrying" ? t("runs.card.retrying") : t("runs.card.throttled") } : { tone: TONE[r().status], label: t(LABEL[r().status]) });
  return (
    <button type="button" class="run-card" data-selected={props.selected ? "" : undefined} data-status={r().status} data-foreign={foreign() ? "" : undefined} aria-current={props.selected ? "true" : undefined} title={foreign() ? `${r().title} (${modelLabel(r().model)}) · ${foreignReason(r().repoIds)}` : `${r().title} (${modelLabel(r().model)})`} onClick={props.onSelect}>
      <span class="run-card__top">
        <StatusDot tone={status().tone} label={status().label} pulse={r().status === "running"} />
        <span class="run-card__title ui-truncate">{r().title}</span>
        <span class="run-card__ago ui-tnum">{ago(r().startedAt)}</span>
      </span>
      <span class="run-card__activity ui-truncate" data-attention={r().status === "needsYou" ? "" : undefined}>
        {activityLine(r(), props.view)}
      </span>
      <Show when={foreign()}>
        <span class="run-card__foreign">{foreignReason(r().repoIds)}</span>
      </Show>
      <span class="run-card__meta">
        <span class="run-card__role">
          <span class="run-card__swatch" style={{ background: roleColor(r().role) ?? "var(--text-4)" }} aria-hidden="true" />
          {r().role === "auto" ? t("runs.role.auto") : r().role}
        </span>
        <Show when={r().location}>{(id) => <LocationChip id={id()} />}</Show>
        <Show when={(r().delegates?.length ?? 0) > 0}>
          <Badge size="sm" class="run-card__lead" title={t("runs.leadTip")}>{t("runs.leadChip", { model: modelLabel(r().model), count: r().delegates!.length })}</Badge>
        </Show>
        <span class="run-card__repos" role="group" aria-label={t("runs.repos")}>
          <For each={r().repoIds.slice(0, MAX_REPOS)}>{(id) => <Show when={repoConfig(id)} fallback={<Badge size="sm">{id}</Badge>}>{(c) => <RepoBadge color={c().color} badge={c().badge} size={16} title={c().name} />}</Show>}</For>
          <Show when={r().repoIds.length > MAX_REPOS}>
            <Badge size="sm" numeric title={r().repoIds.slice(MAX_REPOS).map((id) => repoConfig(id)?.name ?? id).join(", ")}>
              +{r().repoIds.length - MAX_REPOS}
            </Badge>
          </Show>
        </span>
        <span class="run-card__grow" />
        <Show when={effectiveMode(r()) === "bypass"}>
          <Badge size="sm" tone="danger" variant="solid" title={t("modes.header.bypassTip")}>
            {t("modes.header.bypassChip")}
          </Badge>
        </Show>
        <Badge size="sm" numeric title={cost().title}>
          {cost().text}
        </Badge>
        <Badge size="sm" tone={TIER_TONE[r().enforcement]} variant="outline" icon={ShieldCheck} title={TIER_TITLE[r().enforcement]}>
          {TIER_LABEL[r().enforcement]}
        </Badge>
      </span>
    </button>
  );
}
