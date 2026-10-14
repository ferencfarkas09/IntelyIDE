import { createSignal, For, Show } from "solid-js";
import { timeAgo } from "../../components/push/logic";
import { t } from "../../i18n";
import type { TeamSnapshotCommit } from "../../ipc/team";
import { Badge, Button } from "../../ui-kit";
import "./team.css";

/** How many rows show before "Show all". */
export const COMMITS_SHOWN = 10;

/** A commit of a teammate's branch. `who` and `project` are the member chip and project of the team timeline. Subject and author are plain text. */
export function CommitRow(props: { commit: TeamSnapshotCommit; now: number; who?: string; project?: string }) {
  return (
    <li class="team-commit" data-unpushed={props.commit.unpushed ? "" : undefined}>
      <span class="team-commit__oid ui-mono">{props.commit.oid}</span>
      <span class="team-commit__main">
        <span class="team-commit__subject ui-truncate" title={props.commit.subject}>{props.commit.subject}</span>
        <span class="team-commit__meta">
          <Show when={props.who}>{(w) => <Badge size="sm" tone="neutral">{w()}</Badge>}</Show>
          <Show when={props.project}>{(p) => <span class="ui-truncate">{p()}</span>}</Show>
          <span class="ui-truncate">{props.commit.author}</span>
          <span class="ui-tnum">{timeAgo(props.commit.at, props.now)}</span>
        </span>
      </span>
      <Show when={props.commit.unpushed}><Badge size="sm" tone="warn">{t("team.commits.unpushed")}</Badge></Show>
    </li>
  );
}

/** Commit rows, newest first, cut after ten with a "Show all" button. */
export function CommitList(props: { commits: Array<TeamSnapshotCommit & { who?: string; project?: string }>; now: number; label: string }) {
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? props.commits : props.commits.slice(0, COMMITS_SHOWN));
  return (
    <>
      <ul class="team-commits__list" aria-label={props.label}>
        <For each={shown()}>{(c) => <CommitRow commit={c} now={props.now} who={c.who} project={c.project} />}</For>
      </ul>
      <Show when={!all() && props.commits.length > COMMITS_SHOWN}>
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>{t("team.commits.showAll", { n: props.commits.length })}</Button>
      </Show>
    </>
  );
}
