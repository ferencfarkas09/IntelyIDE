import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ipc } from "../../ipc";
import type { TeamMemoryChoice, TeamMemoryConflict, TeamMemoryPending, TeamMemoryPendingChoice, TeamMemoryProject, TeamMemoryStatus } from "../../ipc/team";
import { t } from "../../i18n";
import { timeAgo } from "../../components/push/logic";
import { Badge, Button, EmptyState, FileText, RefreshCw, TriangleAlert } from "../../ui-kit";
import { messageOf } from "./store";

/**
 * Shared Claude memory (beta): which memory files and CLAUDE.md files are in sync with the team, who wrote the version everyone has,
 * and the conflicts. A conflict is never merged for you: the teammate's text is the file, yours is kept next to it, and you choose.
 */
export default function MemoryPane() {
  const [status, setStatus] = createSignal<TeamMemoryStatus | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const load = () => ipc.team.memory.status().then(setStatus, (e) => setError(messageOf(e)));
  onMount(() => {
    void load();
    const off = ipc.team.memory.onChanged(() => void load());
    // the "time ago" labels and the `syncing` flag move without an event
    const timer = setInterval(() => void load(), 15_000);
    onCleanup(() => (off(), clearInterval(timer)));
  });
  const syncNow = () => ipc.team.memory.syncNow().then(() => load(), (e) => setError(messageOf(e)));
  const resolve = (project: string, c: TeamMemoryConflict, choice: TeamMemoryChoice) =>
    ipc.team.memory.resolve(project, c.path, choice).then(() => (setError(undefined), load()), (e) => (setError(messageOf(e)), void load()));
  const decide = (project: string, p: TeamMemoryPending, choice: TeamMemoryPendingChoice) =>
    ipc.team.memory.pendingResolve(project, p.path, choice).then(() => (setError(undefined), load()), (e) => (setError(messageOf(e)), void load()));
  return (
    <div class="team-mem" data-testid="team-memory">
      <header class="team-mem__head">
        <h4 class="team-card__title">{t("team.mem.title")}</h4>
        <Badge size="sm" tone="info">{t("team.mem.beta")}</Badge>
        <span class="team-row__grow" />
        <Show when={status()}>
          {(s) => (
            <span class="team-note">{s().lastSync ? t("team.mem.lastSync", { when: timeAgo(s().lastSync) }) : t("team.mem.never")}</span>
          )}
        </Show>
        <Button size="sm" variant="secondary" icon={RefreshCw} disabled={!status()?.enabled || !status()?.connected || status()?.syncing} onClick={() => void syncNow()}>
          {status()?.syncing ? t("team.mem.syncing") : t("team.mem.syncNow")}
        </Button>
      </header>
      <Show when={error() ?? status()?.error}>{(m) => <p class="team-error team-mem__pad" role="alert">{m()}</p>}</Show>
      <Show when={status()}>
        {(s) => (
          <Show when={s().enabled} fallback={<EmptyState icon={FileText} size="sm" title={t("team.mem.offTitle")} description={t("team.mem.offDesc")} />}>
            <Show when={!s().connected}><p class="team-note team-mem__pad"><TriangleAlert size={12} /> {t("team.mem.offline")}</p></Show>
            <Show when={s().rejected > 0}><p class="team-note team-mem__pad"><TriangleAlert size={12} /> {t("team.mem.rejected", { n: s().rejected })}</p></Show>
            <Show when={s().skipped > 0}><p class="team-note team-mem__pad">{t("team.mem.skipped", { n: s().skipped })}</p></Show>
            <Show when={s().projects.length > 0} fallback={<p class="team-note team-mem__pad">{t("team.mem.noneOpen")}</p>}>
              <For each={s().projects}>{(p) => <Project project={p} onResolve={resolve} onDecide={decide} />}</For>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}

/** Lines of `a` that `b` does not have (a plain set comparison: enough to see what moved, no merge is offered). */
const changedLines = (a: string, b: string) => {
  const other = new Set(b.split("\n"));
  return a.split("\n").map((text) => ({ text, changed: !other.has(text) }));
};

function PendingCard(props: { project: string; pending: TeamMemoryPending; onDecide: (project: string, p: TeamMemoryPending, choice: TeamMemoryPendingChoice) => void }) {
  const [diff, setDiff] = createSignal<{ current: string; incoming: string } | undefined>(undefined);
  const [open, setOpen] = createSignal(false);
  const toggle = () => {
    if (open()) return setOpen(false);
    void ipc.team.memory.pendingDiff(props.project, props.pending.path).then((d) => (setDiff(d), setOpen(true)), () => setOpen(false));
  };
  return (
    <li class="team-mem__conflict" data-testid="memory-pending">
      <span class="team-mem__path ui-truncate">{props.pending.path}</span>
      <span class="team-note">{t(props.pending.deleted ? "team.mem.pendingDeleted" : "team.mem.pendingBody", { name: props.pending.author })}</span>
      <span class="team-mem__actions">
        <Button size="sm" variant="secondary" aria-expanded={open()} onClick={toggle}>{open() ? t("team.mem.hideDiff") : t("team.mem.viewDiff")}</Button>
        <Button size="sm" variant="secondary" onClick={() => props.onDecide(props.project, props.pending, "ignore")}>{t("team.mem.ignore")}</Button>
        <Button size="sm" variant="primary" onClick={() => props.onDecide(props.project, props.pending, "apply")}>{t("team.mem.apply")}</Button>
      </span>
      <Show when={open() ? diff() : undefined}>
        {(d) => (
          <div class="team-mem__diff" data-testid="memory-diff">
            <div>
              <h6 class="team-note">{t("team.mem.diffMine")}</h6>
              <pre><For each={changedLines(d().current, d().incoming)}>{(l) => <span data-changed={l.changed}>{l.text + "\n"}</span>}</For></pre>
            </div>
            <div>
              <h6 class="team-note">{t("team.mem.diffTheirs")}</h6>
              <pre><For each={changedLines(d().incoming, d().current)}>{(l) => <span data-changed={l.changed}>{l.text + "\n"}</span>}</For></pre>
            </div>
          </div>
        )}
      </Show>
    </li>
  );
}

function Project(props: {
  project: TeamMemoryProject;
  onResolve: (project: string, c: TeamMemoryConflict, choice: TeamMemoryChoice) => void;
  onDecide: (project: string, p: TeamMemoryPending, choice: TeamMemoryPendingChoice) => void;
}) {
  const p = () => props.project;
  return (
    <section class="team-mem__project" aria-label={p().name}>
      <h5 class="team-card__title">{p().name}</h5>
      <Show when={p().pending.length > 0}>
        <ul class="team-mem__list" aria-label={t("team.mem.pendingList")}>
          <For each={p().pending}>{(x) => <PendingCard project={p().key} pending={x} onDecide={props.onDecide} />}</For>
        </ul>
      </Show>
      <Show when={p().conflicts.length > 0}>
        <ul class="team-mem__list" aria-label={t("team.mem.conflicts")}>
          <For each={p().conflicts}>
            {(c) => (
              <li class="team-mem__conflict" data-testid="memory-conflict">
                <span class="team-mem__path ui-truncate">{c.path}</span>
                <span class="team-note">{t("team.mem.conflictBody", { name: c.theirs, file: c.file })}</span>
                <span class="team-mem__actions">
                  <Button size="sm" variant="secondary" onClick={() => props.onResolve(p().key, c, "theirs")}>{t("team.mem.keepTheirs")}</Button>
                  <Button size="sm" variant="secondary" onClick={() => props.onResolve(p().key, c, "mine")}>{t("team.mem.useMine")}</Button>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={p().files.length > 0} fallback={<p class="team-note">{t("team.mem.noFiles")}</p>}>
        <ul class="team-mem__list" aria-label={t("team.mem.files")}>
          <For each={p().files}>
            {(f) => (
              <li class="team-mem__file">
                <FileText size={12} />
                <span class="team-mem__path ui-truncate">{f.path}</span>
                <span class="team-row__grow" />
                <span class="team-note">{t("team.mem.by", { name: f.author, v: f.version })} · {timeAgo(f.ts)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
