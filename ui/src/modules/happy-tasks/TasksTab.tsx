import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TaskItem } from "../../ipc/happy";
import { openSettings } from "../../platform/settings";
import { happyStatus, providerState, refreshHappyStatus, timerView } from "../../store/happy";
import { applyTasks, providerNote, tasksView } from "../../store/happyNt";
import { Badge, Bot, Button, ChevronDown, ChevronRight, Copy, EmptyState, GitBranch, Icon, IconButton, Input, ListChecks, Play, RefreshCw, Search, Skeleton, Square, TriangleAlert } from "../../ui-kit";
import { branchFor, copyBranch, errorText, startAgent, startTimer, stopTimer } from "./actions";
import { dueLabel, groupByStatus } from "./logic";
import { loadTaskPrefs } from "./prefs";
import "./tasks.css";

const openIntegrations = () => {
  void refreshHappyStatus();
  openSettings("integrations");
};

/** The dock tab: a state-aware shell around the list, so an off or blocked provider explains itself instead of showing nothing. */
export default function TasksTab() {
  const note = () => providerNote("tasks");
  return (
    <Switch fallback={<Tasks />}>
      <Match when={!note() || note()?.state === "off"}>
        <EmptyState icon={ListChecks} title={t("ht.off.title")} description={t("ht.off.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
      <Match when={note()?.state === "waitingForToken"}>
        <EmptyState icon={ListChecks} title={t("hx.wait.title")} description={t("ht.wait.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
      <Match when={note()?.state === "signedOut"}>
        <EmptyState icon={TriangleAlert} tone="danger" title={t("hx.out.title")} description={t("hx.out.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
      <Match when={note()?.state === "notPermitted"}>
        <EmptyState icon={ListChecks} title={t("hx.denied.title")} description={note()?.lastError?.message ?? t("ht.denied.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
    </Switch>
  );
}

function Tasks() {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [query, setQuery] = createSignal("");
  const [showDone, setShowDone] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const view = tasksView;
  const grouped = createMemo(() => groupByStatus(view(), query(), showDone()));

  const timerReady = () => ["ready", "degraded"].includes(providerState("timer") ?? "");
  const timerAllowed = () => timerReady() && happyStatus()?.config.timer.allowActions !== false;

  const load = async () => {
    setLoading(true);
    try {
      applyTasks(await ipc.happy.tasks.list());
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  onMount(() => {
    loadTaskPrefs();
    void load();
  });
  const toggle = (id: string) => setCollapsed((c) => new Set(c.has(id) ? [...c].filter((x) => x !== id) : [...c, id]));
  const hasRows = () => view().tasks.length > 0;

  return (
    <div class="tk">
      <header class="tk__head">
        <h4 class="tk__title">{t("ht.title")}</h4>
        <Show when={hasRows()}><Badge size="sm" numeric title={t("ht.assigned")}>{view().tasks.length}</Badge></Show>
        <IconButton icon={RefreshCw} label={t("hx.refresh")} size="sm" loading={loading()} onClick={() => void load()} />
      </header>
      <div class="tk__search">
        <Input size="sm" aria-label={t("ht.search.label")} placeholder={t("ht.search.placeholder")} leading={<Icon icon={Search} size={12} />} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </div>
      <Show when={view().stale || (error() && hasRows())}>
        <div class="tk__stale" role="status">{t("hx.stale")}</div>
      </Show>
      <div class="tk__list">
        <Show when={!loading() || hasRows()} fallback={<><Skeleton height={48} /><Skeleton height={48} /><Skeleton height={48} /></>}>
          <Show when={!error() || hasRows()} fallback={<EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("ht.loadFailed")} description={error()} action={<Button size="sm" onClick={() => void load()}>{t("hx.retry")}</Button>} />}>
            <For each={grouped().groups.map((g) => g.status.id)} fallback={<EmptyState class="tk__empty" size="sm" icon={ListChecks} title={query() ? t("ht.empty.noMatch") : hasRows() ? t("ht.empty.done") : t("ht.empty.none")} description={query() ? t("ht.empty.noMatchBody") : hasRows() ? t("ht.empty.doneBody") : t("ht.empty.noneBody")} />}>
              {(id) => {
                // Keyed by the status id, so a poll that changes nothing leaves the open rows (and their focus) alone.
                const group = () => grouped().groups.find((g) => g.status.id === id);
                return (
                  <Show when={group()}>
                    {(g) => (
                      <section class="tk__group">
                        <button type="button" class="tk__group-head" aria-expanded={!collapsed().has(id)} onClick={() => toggle(id)}>
                          <Icon icon={collapsed().has(id) ? ChevronRight : ChevronDown} size={12} />
                          <span class="tk__group-name">{g().status.name}</span>
                          <Badge size="sm" numeric>{g().tasks.length}</Badge>
                        </button>
                        <Show when={!collapsed().has(id)}>
                          <For each={g().tasks}>{(task) => <Row task={task} timerAllowed={timerAllowed()} timerReady={timerReady()} />}</For>
                        </Show>
                      </section>
                    )}
                  </Show>
                );
              }}
            </For>
            <Show when={grouped().hiddenDone > 0 || showDone()}>
              <div class="tk__done">
                <Button size="sm" variant="ghost" onClick={() => setShowDone(!showDone())}>{showDone() ? t("ht.hideDone") : t("ht.showDone", { count: grouped().hiddenDone })}</Button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function Row(props: { task: TaskItem; timerAllowed: boolean; timerReady: boolean }) {
  const tracking = () => timerView().taskId === props.task.id && (timerView().phase === "running" || timerView().phase === "paused");
  const due = () => dueLabel(props.task.dueMs, Date.now());
  const timerHint = () =>
    !props.timerReady ? t("ht.timerHint.off") : !props.timerAllowed ? t("ht.timerHint.blocked") : !props.task.projectId ? t("ht.timerHint.noProject") : t("ht.timerHint.start");
  return (
    <div class="tk__row" data-tracking={tracking() ? "" : undefined}>
      <div class="tk__text">
        <span class="tk__name">
          <Show when={props.task.key}><span class="tk__key">{props.task.key}</span></Show>
          <span class="tk__task ui-truncate">{props.task.title}</span>
        </span>
        <span class="tk__meta">
          <Show when={tracking()}><Badge size="sm" tone="ok" icon={Play}>{t("ht.tracking")}</Badge></Show>
          <Show when={props.task.project}><span class="ui-truncate">{props.task.project}</span></Show>
          <Show when={due()}>{(d) => <span class="tk__due" data-overdue={d().overdue ? "" : undefined}>{d().text}</span>}</Show>
          <Show when={props.task.priority && props.task.priority !== "normal"}><Badge size="sm" tone={props.task.priority === "high" ? "warn" : "neutral"}>{t("ht.priority", { priority: props.task.priority ?? "" })}</Badge></Show>
        </span>
      </div>
      <div class="tk__actions">
        <Show
          when={tracking()}
          fallback={<IconButton icon={Play} label={t("ht.startTimer", { title: props.task.title })} tooltip={timerHint()} size="sm" disabled={!props.timerAllowed || !props.task.projectId} onClick={() => void startTimer(props.task)} />}
        >
          <IconButton icon={Square} label={t("ht.stopTimer")} size="sm" onClick={() => void stopTimer()} />
        </Show>
        <IconButton icon={GitBranch} label={t("ht.copyBranch", { title: props.task.title })} tooltip={t("ht.copyBranchTip", { name: branchFor(props.task) })} size="sm" onClick={() => void copyBranch(props.task)} />
        <IconButton icon={Bot} label={t("ht.startAgent", { title: props.task.title })} tooltip={t("ht.startAgentTip")} size="sm" onClick={() => void startAgent(props.task, tasksView())} />
      </div>
    </div>
  );
}
