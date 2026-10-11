import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { timeAgo } from "../../components/push/logic";
import { t, type MessageKey } from "../../i18n";
import type { TeamWorkspaceFile } from "../../ipc/team";
import { BranchPill, Button, EmptyState, Eye, FileDiff, RefreshCw, Spinner, TriangleAlert } from "../../ui-kit";
import { loadWorkspace, problems, requestWorkspace, snapshots, waiting, wsKey } from "./wsStore";
import "./team.css";

const SKIPPED: Record<string, MessageKey> = {
  secret: "team.ws.skipped.secret",
  binary: "team.ws.skipped.binary",
  large: "team.ws.skipped.large",
  unreadable: "team.ws.skipped.unreadable",
  limit: "team.ws.skipped.limit",
};
const PROBLEM: Record<string, MessageKey> = {
  off: "team.ws.problem.off",
  rate: "team.ws.problem.rate",
  noProject: "team.ws.problem.noProject",
  damaged: "team.ws.problem.damaged",
  unavailable: "team.ws.problem.unavailable",
  noAnswer: "team.ws.problem.noAnswer",
  offline: "team.ws.problem.offline",
};
const STATUS_TONE: Record<string, string> = { M: "mod", A: "add", U: "add", D: "del", R: "mod", C: "del", T: "mod", S: "mod" };

interface Line {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
}

/** A unified diff as lines: the header lines of the file, the `@@` lines, additions, deletions and context. */
export function parseUnified(diff: string): Line[] {
  const out: Line[] = [];
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw === "" && !inHunk) continue;
    if (raw.startsWith("@@")) {
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
    } else if (!inHunk) out.push({ kind: "meta", text: raw });
    else if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1) });
    else if (raw.startsWith("[...")) out.push({ kind: "meta", text: raw });
    else out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  while (out.length && out[out.length - 1].kind === "ctx" && out[out.length - 1].text === "") out.pop();
  return out;
}

/** Read-only unified diff, drawn like the edit previews of the transcript. */
export function UnifiedDiff(props: { file: TeamWorkspaceFile }) {
  const lines = createMemo(() => parseUnified(props.file.diff));
  const counts = createMemo(() => ({ add: lines().filter((l) => l.kind === "add").length, del: lines().filter((l) => l.kind === "del").length }));
  return (
    <div class="dpv team-ws__diff" role="group" aria-label={t("chat.tool.changesTo", { path: props.file.path })} data-testid="ws-diff">
      <div class="dpv__head">
        <span class="ui-mono ui-truncate">{props.file.path}</span>
        <span class="dpv__counts ui-tnum">
          <span class="dpv__add">+{counts().add}</span> <span class="dpv__del">−{counts().del}</span>
        </span>
      </div>
      <pre class="dpv__body ui-selectable">
        <For each={lines()}>
          {(l) => (
            <span class="dpv__line" data-kind={l.kind === "hunk" || l.kind === "meta" ? "ctx" : l.kind} data-ws={l.kind}>
              <span class="dpv__sign" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              {l.text}
              {"\n"}
            </span>
          )}
        </For>
      </pre>
    </div>
  );
}

/** The Workspace sub-tab of a member's project: branch, the changed files and the diff of one, from a snapshot the owner's machine built on request. */
export function WorkspaceView(props: { memberId: string; memberName: string; projectKey: string; projectName: string }) {
  const key = () => wsKey(props.memberId, props.projectKey);
  const snap = () => snapshots()[key()];
  const [pick, setPick] = createSignal<string | undefined>(undefined);
  const file = createMemo(() => {
    const s = snap();
    return s?.files.find((f) => f.path === pick()) ?? s?.files[0];
  });
  const [now, setNow] = createSignal(Date.now());
  const refresh = () => {
    setNow(Date.now());
    void requestWorkspace(props.memberId, props.projectKey);
  };
  // the first look asks once; later looks show what is there and wait for "Refresh"
  createEffect(on(key, () => void loadWorkspace(props.memberId, props.projectKey).then((have) => !have && !waiting()[key()] && refresh())));
  onMount(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(id));
  });
  const problem = () => {
    const p = problems()[key()];
    return p ? (Object.hasOwn(PROBLEM, p) ? t(PROBLEM[p]) : p) : undefined;
  };
  return (
    <div class="team-ws" data-testid="team-workspace">
      <header class="team-ws__head">
        <span class="team-run-head__title ui-truncate">{t("team.ws.title", { project: props.projectName })}</span>
        <Show when={snap()}>
          {(s) => (
            <>
              <Show when={s().branch}>{(b) => <BranchPill name={b()} />}</Show>
              <Show when={s().ahead > 0 || s().behind > 0}>
                <span class="team-note ui-tnum" title={t("team.ws.aheadBehind")}>↑{s().ahead} ↓{s().behind}</span>
              </Show>
              <span class="team-note" data-testid="ws-time">{t("team.ws.taken", { ago: timeAgo(s().takenAt, now()) })}</span>
            </>
          )}
        </Show>
        <span class="team-run-head__grow" />
        <Show when={waiting()[key()]}><Spinner size={14} /></Show>
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={waiting()[key()]} onClick={refresh}>{t("team.ws.refresh")}</Button>
      </header>
      <Show when={problem()}>{(m) => <p class="team-warn team-ws__problem" role="alert"><TriangleAlert size={12} /> {m()}</p>}</Show>
      <Show
        when={snap()}
        fallback={<EmptyState icon={Eye} size="sm" title={waiting()[key()] ? t("team.ws.waiting", { name: props.memberName }) : t("team.ws.empty")} description={t("team.ws.emptyDesc")} />}
      >
        {(s) => (
          <div class="team-ws__body">
            <Show when={s().truncated}><p class="team-note team-ws__trunc">{t("team.ws.truncated")}</p></Show>
            <Show when={s().files.length > 0} fallback={<EmptyState icon={FileDiff} size="sm" title={t("team.ws.clean")} />}>
              <ul class="team-ws__files" aria-label={t("team.ws.files")}>
                <For each={s().files}>
                  {(f) => (
                    <li>
                      <button type="button" class="team-ws__file" aria-pressed={file()?.path === f.path} onClick={() => setPick(f.path)}>
                        <span class="team-ws__status" data-tone={STATUS_TONE[f.status] ?? "mod"} aria-hidden="true">{f.status}</span>
                        <span class="ui-mono ui-truncate">{f.path}</span>
                        <Show when={f.skipped}><span class="team-note">{t("team.ws.withheld")}</span></Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <div class="team-ws__main">
                <Show when={file()}>
                  {(f) => (
                    <Show when={!f().skipped} fallback={<p class="team-note team-ws__skipped" data-testid="ws-skipped">{t(SKIPPED[f().skipped as string] ?? "team.ws.skipped.unreadable")}</p>}>
                      <UnifiedDiff file={f()} />
                    </Show>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
