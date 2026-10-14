import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { Transcript } from "../../components/chat/Transcript";
import { t } from "../../i18n";
import type { TeamMember, TeamRun } from "../../ipc/team";
import { openSettings } from "../../platform/settings";
import { Badge, Button, EmptyState, Eye, FileText, GitCommitHorizontal, SegmentedControl, StatusDot, Users } from "../../ui-kit";
import { timeAgo } from "../../components/push/logic";
import { loadRuns, runs, runsError, selected, selectRun, transcript } from "./runs";
import { ChatPanel } from "./ChatPanel";
import CommitsPane from "./CommitsPane";
import MemoryPane from "./MemoryPane";
import { unreadOf, watchChat } from "./chat";
import { watchMemory } from "./memoryWatch";
import { TeamNoteCards, TeamNoteComposer } from "./TeamNotes";
import { loadTeam, loaded, view } from "./store";
import { WorkspaceView } from "./Workspace";
import "../../components/chat/chat.css";
import "./team.css";

const STATE_TONE = { running: "accent", waiting: "warn", idle: "neutral", error: "danger" } as const;
const stateText = (s: TeamRun["state"]) => t(`team.run.state.${s}` as "team.run.state.idle");

/**
 * The Team view: who is online, the runs they share, and one of those runs as a read-only transcript, with a "Workspace" sub-tab (their
 * changes, on request). The only thing you can do to another machine is send a note into a live Claude run; its owner decides. There is
 * no button that answers a permission card or a question, sends a prompt or starts a run.
 */
export default function TeamTab() {
  onMount(() => {
    watchMemory();
    watchChat();
    void loadTeam();
    void loadRuns();
  });
  return (
    <div class="team-tab" data-testid="team-tab">
      <Show when={loaded()}>
        <Show
          when={view().state === "member"}
          fallback={
            <EmptyState
              icon={Users}
              title={t("team.tab.noTeam")}
              description={t("team.tab.noTeamDesc")}
              action={<Button onClick={() => openSettings("team")}>{t("team.tab.openSettings")}</Button>}
            />
          }
        >
          <Body />
        </Show>
      </Show>
    </div>
  );
}

type Sub = "run" | "chat" | "workspace";
// a team-wide pane takes the main area until a run is picked again
type Pane = "memory" | "commits";

function Body() {
  const [sub, setSub] = createSignal<Sub>("run");
  const [pane, setPane] = createSignal<Pane | undefined>(undefined);
  const toggle = (p: Pane) => setPane((cur) => (cur === p ? undefined : p));
  createEffect(on(selected, () => setPane(undefined), { defer: true }));
  const openWorkspace = (memberId: string, runId: string) => {
    selectRun({ memberId, runId });
    setSub("workspace");
    setPane(undefined);
  };
  const others = createMemo(() => view().members.filter((m) => !m.me));
  const runsOf = (id: string) => runs().filter((r) => r.memberId === id);
  const current = createMemo(() => {
    const s = selected();
    return s ? runs().find((r) => r.memberId === s.memberId && r.runId === s.runId) : undefined;
  });
  return (
    <>
      <aside class="team-tab__list" aria-label={t("team.tab.members")}>
        <TeamNoteCards />
        <Show when={runsError()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
        <Show when={others().length > 0} fallback={<p class="team-note team-tab__pad">{t("team.tab.alone")}</p>}>
          <For each={others()}>{(m) => <MemberBlock member={m} runs={runsOf(m.id)} />}</For>
        </Show>
        <Button size="sm" variant={pane() === "commits" ? "primary" : "secondary"} icon={GitCommitHorizontal} aria-pressed={pane() === "commits"} data-testid="team-commits-open" onClick={() => toggle("commits")}>{t("team.commits.tab")}</Button>
        <Button size="sm" variant={pane() === "memory" ? "primary" : "secondary"} icon={FileText} aria-pressed={pane() === "memory"} data-testid="team-memory-open" onClick={() => toggle("memory")}>{t("team.mem.tab")}</Button>
        <p class="team-note team-tab__pad"><Eye size={12} /> {t("team.tab.readOnly")}</p>
      </aside>
      <section class="team-tab__main" aria-label={t("team.tab.transcript")}>
        <Show
          when={pane() ? undefined : current()}
          fallback={pane() === "memory" ? <MemoryPane /> : pane() === "commits" ? <CommitsPane onOpenWorkspace={openWorkspace} /> : <EmptyState icon={Eye} size="sm" title={t("team.tab.pick")} description={runs().length ? t("team.tab.pickDesc") : t("team.tab.noRuns")} />}
        >
          {(r) => (
            <>
              <header class="team-run-head">
                <StatusDot tone={STATE_TONE[r().state]} pulse={r().state === "running"} label={stateText(r().state)} />
                <span class="team-run-head__title ui-truncate">{r().title || t("team.run.untitled")}</span>
                <Badge size="sm" tone={STATE_TONE[r().state]}>{stateText(r().state)}</Badge>
                <Badge size="sm" tone="neutral" title={t("team.run.project")}>{r().projectName}</Badge>
                <span class="team-run-head__grow" />
                <span class="team-note">{t("team.run.by", { name: r().memberName })}</span>
                <Badge size="sm" tone="info" title={t("team.tab.readOnly")}>{t("team.run.readOnly")}</Badge>
              </header>
              <div class="team-tab__sub">
                <SegmentedControl<Sub>
                  size="sm"
                  aria-label={t("team.tab.sub")}
                  value={sub()}
                  onChange={setSub}
                  options={[
                    { value: "run", label: t("team.tab.subRun") },
                    {
                      value: "chat",
                      label: (
                        <>
                          {t("team.chat.tab")}
                          <Show when={unreadOf(r().memberId, r().runId) > 0}>
                            {" "}
                            <Badge tone="accent" numeric size="sm" title={t("team.chat.unread", { n: unreadOf(r().memberId, r().runId) })}>{unreadOf(r().memberId, r().runId)}</Badge>
                          </Show>
                        </>
                      ),
                    },
                    { value: "workspace", label: t("team.tab.subWorkspace") },
                  ]}
                />
              </div>
              <Show when={sub() === "workspace"} fallback={
                <Show when={sub() === "chat"} fallback={<RunSub run={r()} />}>
                  <ChatPanel ownerId={r().memberId} runId={r().runId} ownerName={r().memberName} ownerOnline={view().members.some((m) => m.id === r().memberId && m.online)} />
                </Show>
              }>
                <WorkspaceView memberId={r().memberId} memberName={r().memberName} projectKey={r().projectKey} projectName={r().projectName} />
              </Show>
            </>
          )}
        </Show>
      </section>
    </>
  );
}

/** The Run sub-tab: the read-only transcript, and what you can send under it (a note while it works, a follow-up when it does not). */
function RunSub(props: { run: TeamRun }) {
  return (
    <>
      <Show when={transcript()}>{(v) => <Transcript agentId={props.run.runId} view={v()} readOnly who={props.run.memberName} />}</Show>
      <TeamNoteComposer run={props.run} />
    </>
  );
}

function MemberBlock(props: { member: TeamMember; runs: TeamRun[] }) {
  const now = () => Date.now();
  return (
    <div class="team-tab__member">
      <div class="team-tab__who">
        <StatusDot tone={props.member.online ? "ok" : "neutral"} label={props.member.online ? t("team.member.online") : t("team.member.offline")} />
        <span class="team-row__name">{props.member.name}</span>
        <Show when={props.member.state}><span class="team-row__state">{props.member.state}</span></Show>
        <span class="team-row__grow" />
        <span class="team-row__presence">{props.member.online ? t("team.member.online") : t("team.member.offline")}</span>
      </div>
      <Show when={props.runs.length > 0} fallback={<p class="team-note team-tab__none">{t("team.tab.noneShared")}</p>}>
        <ul class="team-tab__runs">
          <For each={props.runs}>
            {(r) => {
              const on = () => selected()?.memberId === r.memberId && selected()?.runId === r.runId;
              return (
                <li>
                  <button type="button" class="team-tab__run" aria-pressed={on()} data-state={r.state} onClick={() => selectRun({ memberId: r.memberId, runId: r.runId })}>
                    <span class="team-tab__run-top">
                      <StatusDot tone={STATE_TONE[r.state]} pulse={r.state === "running"} size={6} label={stateText(r.state)} />
                      <span class="team-tab__run-title ui-truncate">{r.title || t("team.run.untitled")}</span>
                      <Show when={unreadOf(r.memberId, r.runId) > 0}>
                        <Badge tone="accent" numeric size="sm" title={t("team.chat.unread", { n: unreadOf(r.memberId, r.runId) })}>{unreadOf(r.memberId, r.runId)}</Badge>
                      </Show>
                    </span>
                    <span class="team-tab__run-sub">
                      <span class="ui-truncate">{r.projectName}</span>
                      <span>{stateText(r.state)} · {timeAgo(r.updatedAt, now())}</span>
                    </span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}
