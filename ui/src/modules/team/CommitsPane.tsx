import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { t } from "../../i18n";
import { timeAgo } from "../../components/push/logic";
import { Badge, BranchPill, Button, EmptyState, GitCommitHorizontal, RefreshCw, Spinner, StatusDot, TriangleAlert } from "../../ui-kit";
import { CommitList } from "./CommitList";
import { runs } from "./runs";
import { view } from "./store";
import { PROBLEM } from "./Workspace";
import { loadWorkspace, problems, requestWorkspaceThrottled, snapshots, waiting, wsKey } from "./wsStore";
import "./team.css";

interface Target {
  memberId: string;
  memberName: string;
  online: boolean;
  projectKey: string;
  projectName: string;
  /** A shared run of that member in the project: where "files edited" jumps to. */
  runId: string;
}

/** Team-wide: for every member and every project they share a run in, the branch, the edited files and the recent commits, and all commits as one timeline. */
export default function CommitsPane(props: { onOpenWorkspace: (memberId: string, runId: string) => void }) {
  const targets = createMemo<Target[]>(() => {
    const seen = new Set<string>();
    const out: Target[] = [];
    for (const r of runs()) {
      const key = wsKey(r.memberId, r.projectKey);
      if (seen.has(key)) continue;
      seen.add(key);
      const online = view().members.some((m) => m.id === r.memberId && m.online);
      out.push({ memberId: r.memberId, memberName: r.memberName, online, projectKey: r.projectKey, projectName: r.projectName, runId: r.runId });
    }
    return out;
  });
  const [now, setNow] = createSignal(Date.now());
  // reads what this install already has, then asks (at most one request per member and project every 30 s)
  const ask = (list: Target[]) => {
    setNow(Date.now());
    for (const x of list) if (x.online) void loadWorkspace(x.memberId, x.projectKey).then(() => requestWorkspaceThrottled(x.memberId, x.projectKey));
  };
  createEffect(on(() => targets().map((x) => `${x.memberId}:${x.projectKey}:${x.online}`).join("|"), () => untrack(() => ask(targets()))));
  onMount(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(id));
  });
  const busy = () => targets().some((x) => waiting()[wsKey(x.memberId, x.projectKey)]);
  const timeline = createMemo(() =>
    targets()
      .flatMap((x) => (snapshots()[wsKey(x.memberId, x.projectKey)]?.commits ?? []).map((c) => ({ ...c, who: x.memberName, project: x.projectName })))
      .sort((a, b) => b.at - a.at),
  );
  return (
    <div class="team-mem team-commitspane" data-testid="team-commits">
      <header class="team-mem__head">
        <span class="team-run-head__title">{t("team.commits.pane")}</span>
        <span class="team-run-head__grow" />
        <Show when={busy()}><Spinner size={14} /></Show>
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={busy() || targets().length === 0} onClick={() => ask(targets())}>{t("team.commits.refreshAll")}</Button>
      </header>
      <Show when={targets().length > 0} fallback={<EmptyState icon={GitCommitHorizontal} size="sm" title={t("team.commits.noTargets")} description={t("team.commits.noTargetsDesc")} />}>
        <ul class="team-commitspane__targets" aria-label={t("team.commits.targets")}>
          <For each={targets()}>{(x) => <TargetCard target={x} now={now()} onOpen={() => props.onOpenWorkspace(x.memberId, x.runId)} />}</For>
        </ul>
        <section class="team-commitspane__timeline" aria-label={t("team.commits.timeline")}>
          <h3 class="team-commits__title">{t("team.commits.timeline")}</h3>
          <Show when={timeline().length > 0} fallback={<p class="team-note">{t("team.commits.timelineEmpty")}</p>}>
            <CommitList commits={timeline()} now={now()} label={t("team.commits.timeline")} />
          </Show>
        </section>
      </Show>
    </div>
  );
}

function TargetCard(props: { target: Target; now: number; onOpen: () => void }) {
  const key = () => wsKey(props.target.memberId, props.target.projectKey);
  const snap = () => snapshots()[key()];
  const problem = () => {
    const p = problems()[key()];
    if (!p) return undefined;
    return p === "off" ? t("team.commits.off") : Object.hasOwn(PROBLEM, p) ? t(PROBLEM[p]) : p;
  };
  return (
    <li class="team-commitspane__target" data-testid="team-commits-target">
      <div class="team-commitspane__who">
        <StatusDot tone={props.target.online ? "ok" : "neutral"} label={props.target.online ? t("team.member.online") : t("team.member.offline")} />
        <span class="team-row__name">{props.target.memberName}</span>
        <Badge size="sm" tone="neutral" title={t("team.run.project")}>{props.target.projectName}</Badge>
        <Show when={snap()}>
          {(s) => (
            <>
              <Show when={s().branch}>{(b) => <BranchPill name={b()} />}</Show>
              <Show when={s().ahead > 0 || s().behind > 0}><span class="team-note ui-tnum" title={t("team.ws.aheadBehind")}>↑{s().ahead} ↓{s().behind}</span></Show>
            </>
          )}
        </Show>
        <span class="team-run-head__grow" />
        <Show when={waiting()[key()]}><Spinner size={12} /></Show>
      </div>
      <Show when={!props.target.online}><p class="team-note">{t("team.commits.offline", { name: props.target.memberName })}</p></Show>
      <Show when={problem()}>{(m) => <p class="team-warn" role="alert"><TriangleAlert size={12} /> {m()}</p>}</Show>
      <Show when={snap()}>
        {(s) => (
          <div class="team-commitspane__line">
            <Show when={s().files.length > 0} fallback={<span class="team-note">{t("team.commits.noFiles")}</span>}>
              <Button size="sm" variant="ghost" onClick={props.onOpen}>{t("team.commits.files", { n: s().files.length })}</Button>
            </Show>
            <span class="team-note">{t("team.commits.recent", { n: s().commits?.length ?? 0 })}</span>
            <span class="team-note" data-testid="commits-time">{t("team.ws.taken", { ago: timeAgo(s().takenAt, props.now) })}</span>
          </div>
        )}
      </Show>
    </li>
  );
}
