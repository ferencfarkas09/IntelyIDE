import { createMemo, For, Show } from "solid-js";
import { t } from "../../i18n";
import { agentRows, agentView, selectAgent, selectedAgentId } from "../../store/agents";
import { hiddenCount, scopeRows, setShowOtherWorkspaces, showOtherWorkspaces } from "../../store/agentScope";
import { repoConfig } from "../../store/workspace";
import { Badge, Bot, Button, Checkbox, EmptyState, Inbox, Plus, ScrollArea, Select } from "../../ui-kit";
import { execute } from "../../platform/commands";
import { RunCard } from "./RunCard";
import { reviewedRuns } from "./reviewed";
import { filterChoices, groupSessions, NO_FILTER } from "./sessionsLogic";
import { centreView, sessionFilter, setCentreView, setSessionFilter } from "./state";
import { inboxCount } from "./inbox";

/** Left side of the Agent workspace: every run grouped by what the user has to do about it, filterable by role and repo. */
export function SessionsSidebar() {
  // Runs of other workspaces stay out of the list until the toggle is on (read-only then).
  const scoped = createMemo(() => scopeRows(agentRows()));
  const hidden = createMemo(() => hiddenCount(agentRows()));
  const choices = createMemo(() => filterChoices(scoped()));
  const groups = createMemo(() => groupSessions(scoped(), sessionFilter(), reviewedRuns(), Date.now()));
  const filtered = () => sessionFilter().role !== "" || sessionFilter().repoId !== "";
  const open = (id: string) => {
    setCentreView("run");
    void selectAgent(id);
  };
  return (
    <aside class="sessions" aria-label={t("runs.sessions.label")}>
      <div class="sessions__bar">
        <span class="sessions__title">{t("runs.sessions.title")}</span>
        <span class="sessions__grow" />
        <Button size="sm" variant="ghost" icon={Inbox} aria-pressed={centreView() === "inbox"} onClick={() => setCentreView(centreView() === "inbox" ? "run" : "inbox")} title={t("runs.sessions.inboxTip")}>
          {t("runs.sessions.inbox")}
          <Show when={inboxCount() > 0}>
            <Badge tone="warn" numeric size="sm">
              {inboxCount()}
            </Badge>
          </Show>
        </Button>
        <Button size="sm" variant="primary" icon={Plus} onClick={() => void execute("runs.new")}>
          {t("runs.sessions.new")}
        </Button>
      </div>
      <div class="sessions__filters">
        <Select
          size="sm"
          aria-label={t("runs.sessions.filterRole")}
          value={sessionFilter().role}
          onChange={(role) => setSessionFilter({ ...sessionFilter(), role })}
          options={[{ value: "", label: t("runs.sessions.allRoles") }, ...choices().roles.map((r) => ({ value: r, label: r }))]}
        />
        <Select
          size="sm"
          aria-label={t("runs.sessions.filterRepo")}
          value={sessionFilter().repoId}
          onChange={(repoId) => setSessionFilter({ ...sessionFilter(), repoId })}
          options={[{ value: "", label: t("runs.sessions.allRepos") }, ...choices().repoIds.map((id) => ({ value: id, label: repoConfig(id)?.name ?? id }))]}
        />
      </div>
      <Show when={hidden() > 0 || showOtherWorkspaces()}>
        <div class="sessions__scope">
          <Checkbox size="sm" label={t("scope.toggle")} checked={showOtherWorkspaces()} onChange={setShowOtherWorkspaces} />
          <Show when={hidden() > 0}>
            <span class="sessions__hidden" role="status">{t("scope.hidden", { count: hidden() })}</span>
          </Show>
        </div>
      </Show>
      <Show
        when={groups().length > 0}
        fallback={
          <EmptyState
            icon={Bot}
            size="sm"
            title={filtered() ? t("runs.sessions.noMatch") : t("runs.sessions.none")}
            description={filtered() ? t("runs.sessions.noMatchDesc") : t("runs.sessions.noneDesc")}
            action={
              <Button size="sm" variant="secondary" onClick={() => (filtered() ? setSessionFilter(NO_FILTER) : void execute("runs.new"))}>
                {filtered() ? t("runs.clearFilters") : t("runs.newRun")}
              </Button>
            }
          />
        }
      >
        <ScrollArea class="sessions__list">
          <div class="sessions__inner">
            <For each={groups()}>
              {(g) => (
                <section class="sessions__group" aria-label={g.title}>
                  <h3 class="sessions__group-title">
                    {g.title}
                    <Badge numeric size="sm" tone={g.id === "needsYou" ? "warn" : "neutral"}>
                      {g.rows.length}
                    </Badge>
                  </h3>
                  <For each={g.rows}>{(row) => <RunCard row={row} view={agentView(row.agentId)} selected={centreView() === "run" && selectedAgentId() === row.agentId} onSelect={() => open(row.agentId)} />}</For>
                </section>
              )}
            </For>
          </div>
        </ScrollArea>
      </Show>
    </aside>
  );
}
