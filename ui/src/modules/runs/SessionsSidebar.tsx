import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { StartingCard } from "../../components/chat/Starting";
import { agentRows, agentView, selectAgent, selectedAgentId, selectStartingRun } from "../../store/agents";
import { startingInFront, startingRuns } from "../../store/starting";
import { hiddenCount, scopeRows, setShowOtherWorkspaces, showOtherWorkspaces } from "../../store/agentScope";
import { repoConfig } from "../../store/workspace";
import { Badge, Bot, Button, Checkbox, ChevronDown, ChevronRight, EmptyState, Icon, IconButton, Inbox, Plus, ScrollArea, Select, toast, X } from "../../ui-kit";
import { execute } from "../../platform/commands";
import { RunCard, RunRow } from "./RunCard";
import { closedRuns, closeRuns, reopenRuns } from "./closed";
import { reviewedRuns } from "./reviewed";
import { closedCount, filterChoices, groupSessions, isClosed, NO_FILTER, previewRows, type SessionGroup } from "./sessionsLogic";
import { centreView, sessionFilter, setCentreView, setSessionFilter } from "./state";
import { inboxCount } from "./inbox";

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/** The groups of runs that have stopped: compact rows, collapsible, closable. The live groups keep their full cards. */
const finishedGroup = (id: SessionGroup) => id === "review" || id === "done";

/** Left side of the Agent workspace: every run grouped by what the user has to do about it, filterable by role and repo. */
export function SessionsSidebar() {
  // Runs of other workspaces stay out of the list until the toggle is on (read-only then).
  const scoped = createMemo(() => scopeRows(agentRows()));
  const hidden = createMemo(() => hiddenCount(agentRows()));
  const choices = createMemo(() => filterChoices(scoped()));
  const [showClosed, setShowClosed] = createSignal(false);
  // Groups the person opened up to every run (the others show the newest few) and groups they folded away.
  const [expanded, setExpanded] = createSignal<ReadonlySet<SessionGroup>>(new Set());
  const [folded, setFolded] = createSignal<ReadonlySet<SessionGroup>>(new Set());
  const toggle = (set: () => ReadonlySet<SessionGroup>, put: (s: ReadonlySet<SessionGroup>) => void, id: SessionGroup) => {
    const next = new Set(set());
    if (!next.delete(id)) next.add(id);
    put(next);
  };
  const groups = createMemo(() => groupSessions(scoped(), sessionFilter(), reviewedRuns(), Date.now(), { closed: closedRuns(), showClosed: showClosed() }));
  const groupIds = createMemo(() => groups().map((g) => g.id), [], { equals: sameIds });
  const closedN = createMemo(() => closedCount(scoped(), sessionFilter(), closedRuns()));
  const filtered = () => sessionFilter().role !== "" || sessionFilter().repoId !== "";
  /** Closes every finished run of a group that is still open, and offers to take it back. */
  const closeGroup = (rows: readonly { agentId: string; status: "running" | "needsYou" | "done" | "error" }[]) => {
    const ids = rows.filter((r) => !isClosed(r, closedRuns())).map((r) => r.agentId);
    if (ids.length === 0) return;
    closeRuns(ids);
    toast.show({ title: t("runs.closed.toast", { count: ids.length }), description: t("runs.closed.toastDesc"), duration: 8000, action: { label: t("runs.closed.undo"), onSelect: () => reopenRuns(ids) } });
  };
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
        when={groups().length > 0 || startingRuns().length > 0}
        fallback={
          <EmptyState
            icon={Bot}
            size="sm"
            title={filtered() ? t("runs.sessions.noMatch") : closedN() > 0 ? t("runs.closed.allTitle") : t("runs.sessions.none")}
            description={filtered() ? (closedN() > 0 ? t("runs.closed.noMatchDesc") : t("runs.sessions.noMatchDesc")) : closedN() > 0 ? t("runs.closed.allDesc", { count: closedN() }) : t("runs.sessions.noneDesc")}
            action={
              <div class="sessions__empty-actions">
                <Button size="sm" variant="secondary" onClick={() => (filtered() ? setSessionFilter(NO_FILTER) : closedN() > 0 ? setShowClosed(true) : void execute("runs.new"))}>
                  {filtered() ? t("runs.clearFilters") : closedN() > 0 ? t("runs.closed.show", { count: closedN() }) : t("runs.newRun")}
                </Button>
                <Show when={filtered() && closedN() > 0}>
                  <Button size="sm" variant="ghost" onClick={() => setShowClosed(true)}>
                    {t("runs.closed.show", { count: closedN() })}
                  </Button>
                </Show>
              </div>
            }
          />
        }
      >
        <ScrollArea class="sessions__list">
          <div class="sessions__inner">
            <Show when={startingRuns().length > 0}>
              <section class="sessions__group" aria-label={t("runs.starting.group")}>
                <h3 class="sessions__group-title">
                  {t("runs.starting.group")}
                  <Badge numeric size="sm">
                    {startingRuns().length}
                  </Badge>
                </h3>
                <For each={startingRuns()}>
                  {(run) => <StartingCard run={run} selected={centreView() === "run" && startingInFront() === run.key} onSelect={() => (setCentreView("run"), selectStartingRun(run.key))} />}
                </For>
              </section>
            </Show>
            {/* Keyed by id, not by row object: every event of a working run builds new row objects, and a list keyed by them would drop the keyboard focus. */}
            <For each={groupIds()}>
              {(gid) => {
                const group = createMemo(() => groups().find((g) => g.id === gid));
                const finished = finishedGroup(gid);
                const isFolded = () => finished && folded().has(gid);
                const rows = () => group()?.rows ?? [];
                const preview = createMemo(() => previewRows(rows(), gid, expanded().has(gid)));
                const shownIds = createMemo(() => preview().shown.map((r) => r.agentId), [], { equals: sameIds });
                const openRows = () => rows().filter((r) => !isClosed(r, closedRuns()));
                return (
                  <Show when={group()}>
                    {(g) => (
                      <section class="sessions__group" aria-label={g().title}>
                        <div class="sessions__group-head">
                          <h3 class="sessions__group-title">
                            <Show
                              when={finished}
                              fallback={
                                <>
                                  {g().title}
                                  <Badge numeric size="sm" tone={gid === "needsYou" ? "warn" : "neutral"}>
                                    {g().rows.length}
                                  </Badge>
                                </>
                              }
                            >
                              <button type="button" class="sessions__group-toggle" aria-expanded={!isFolded()} title={isFolded() ? t("runs.group.expand", { title: g().title }) : t("runs.group.collapse", { title: g().title })} onClick={() => toggle(folded, setFolded, gid)}>
                                <Icon icon={isFolded() ? ChevronRight : ChevronDown} size={12} />
                                {g().title}
                                <Badge numeric size="sm">
                                  {g().rows.length}
                                </Badge>
                              </button>
                            </Show>
                          </h3>
                          <Show when={finished && openRows().length > 0}>
                            <IconButton class="sessions__group-close" size="sm" icon={X} label={t("runs.closed.closeAll", { title: g().title })} tooltip={t("runs.closed.closeAllTip")} tooltipPlacement="left" onClick={() => closeGroup(openRows())} />
                          </Show>
                        </div>
                        <Show when={!isFolded()}>
                          <For each={shownIds()}>
                            {(id) => {
                              const row = createMemo(() => rows().find((r) => r.agentId === id));
                              return (
                                <Show when={row()}>
                                  {(r) =>
                                    finished ? (
                                      <RunRow row={r()} view={agentView(id)} detail={gid === "review"} closed={isClosed(r(), closedRuns())} selected={centreView() === "run" && selectedAgentId() === id} onSelect={() => open(id)} onClose={() => closeRuns([id])} onReopen={() => reopenRuns([id])} />
                                    ) : (
                                      <RunCard row={r()} view={agentView(id)} selected={centreView() === "run" && selectedAgentId() === id} onSelect={() => open(id)} />
                                    )
                                  }
                                </Show>
                              );
                            }}
                          </For>
                          <Show when={preview().hidden > 0}>
                            <button type="button" class="sessions__more" onClick={() => toggle(expanded, setExpanded, gid)}>
                              {t("runs.group.more", { count: preview().hidden })}
                            </button>
                          </Show>
                          <Show when={finished && expanded().has(gid) && rows().length > previewRows(rows(), gid, false).shown.length}>
                            <button type="button" class="sessions__more" onClick={() => toggle(expanded, setExpanded, gid)}>
                              {t("runs.group.fewer")}
                            </button>
                          </Show>
                        </Show>
                      </section>
                    )}
                  </Show>
                );
              }}
            </For>
            <Show when={closedN() > 0 || showClosed()}>
              <button type="button" class="sessions__closed" data-on={showClosed() ? "" : undefined} onClick={() => setShowClosed(!showClosed())}>
                {showClosed() ? t("runs.closed.hide") : t("runs.closed.show", { count: closedN() })}
              </button>
            </Show>
          </div>
        </ScrollArea>
      </Show>
    </aside>
  );
}
