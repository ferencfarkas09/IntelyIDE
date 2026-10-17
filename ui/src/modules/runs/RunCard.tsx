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
import { announce, Badge, IconButton, Icon, MessagesSquare, RepoBadge, ShieldCheck, StatusDot, Undo2, X } from "../../ui-kit";
import { focusNeighbour } from "./listFocus";
import { roleColor } from "./roleColors";
import { activityLine } from "./sessionsLogic";

const TONE = { running: "accent", needsYou: "warn", done: "ok", error: "danger" } as const;
const MAX_REPOS = 2;
const LABEL = { running: "runs.running", needsYou: "runs.needsYou", done: "runs.done", error: "runs.failed" } as const satisfies Record<AgentRow["status"], MessageKey>;

/** One run in the sessions list: live status, what it is doing, who runs it where, what it costs and how well it is fenced. */
export function RunCard(props: { row: AgentRow; view: AgentView | undefined; selected: boolean; onSelect: () => void }) {
  const r = () => props.row;
  const foreign = () => isForeign(r().repoIds);
  /** The run has sent or received messages to or from another run of the same person. */
  const talking = () => props.view?.items.some((i) => i.type === "note" && (i.from !== undefined || i.to !== undefined)) === true;
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
        <Show when={talking()}>
          <span class="run-card__peer" title={t("peer.talking")} role="img" aria-label={t("peer.talking")} data-testid="run-talking">
            <Icon icon={MessagesSquare} size={12} />
          </span>
        </Show>
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

/**
 * A finished run in the sessions list: one line (what it was, who ran it, how long ago) and a button to close it. Closing only hides the
 * run from the list; `detail` adds the last words of the run under the title (the review group, where that is what you are looking for).
 */
export function RunRow(props: { row: AgentRow; view: AgentView | undefined; selected: boolean; detail: boolean; closed: boolean; onSelect: () => void; onClose: () => void; onReopen: () => void }) {
  const r = () => props.row;
  const foreign = () => isForeign(r().repoIds);
  const role = () => (r().role === "auto" ? t("runs.role.auto") : r().role);
  const status = () => ({ tone: TONE[r().status], label: t(LABEL[r().status]) });
  const tip = () => `${r().title} · ${role()} · ${modelLabel(r().model)}${foreign() ? ` · ${foreignReason(r().repoIds)}` : ""}`;
  let box!: HTMLDivElement;
  // Closing takes the row out of the list: the focus moves on first, and a screen reader is told what happened.
  const toggle = () => {
    focusNeighbour(box, ".run-row", ".sessions__group-toggle");
    announce(t(props.closed ? "runs.closed.reopened" : "runs.closed.one", { title: r().title }));
    if (props.closed) props.onReopen();
    else props.onClose();
  };
  return (
    <div ref={box} class="run-row" data-selected={props.selected ? "" : undefined} data-status={r().status} data-closed={props.closed ? "" : undefined} data-detail={props.detail ? "" : undefined} data-foreign={foreign() ? "" : undefined}>
      <button
        type="button"
        class="run-row__main"
        aria-current={props.selected ? "true" : undefined}
        title={tip()}
        onClick={props.onSelect}
        onKeyDown={(e) => (e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey && (e.preventDefault(), toggle())}
      >
        <span class="run-row__top">
          <StatusDot tone={status().tone} label={status().label} />
          <span class="run-row__title ui-truncate">{r().title}</span>
          <span class="run-row__ago ui-tnum">{ago(r().startedAt)}</span>
        </span>
        <Show when={props.detail}>
          <span class="run-row__activity ui-truncate">{activityLine(r(), props.view)}</span>
        </Show>
        <Show when={foreign()}>
          <span class="run-row__foreign">{foreignReason(r().repoIds)}</span>
        </Show>
      </button>
      <IconButton class="run-row__close" size="sm" icon={props.closed ? Undo2 : X} label={t(props.closed ? "runs.closed.reopenRun" : "runs.closed.closeRun", { title: r().title })} tooltip={t(props.closed ? "runs.closed.reopen" : "runs.closed.close")} tooltipPlacement="left" onClick={toggle} />
    </div>
  );
}
