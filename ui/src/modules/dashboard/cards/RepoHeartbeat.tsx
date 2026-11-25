import { createEffect, createSignal, For, on, Show } from "solid-js";
import { firstDiffTarget } from "../../../components/diff/logic";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import { setToolWindow } from "../../../platform/rail";
import type { WidgetProps } from "../../../platform/widgets";
import { setPanelOpen } from "../../../shell/layout";
import { setSelectedFile } from "../../../store/selection";
import { repoError, snapshots } from "../../../store/snapshots";
import { repos, workspaceState } from "../../../store/workspace";
import { FolderGit2, Skeleton } from "../../../ui-kit";
import { subjectOf } from "../logic";
import { CardEmpty, CardLoading } from "../parts";

/** Last commit subjects by `repoId@oid`: read once per new HEAD, never polled. */
const subjects = new Map<string, string>();
const [subjectTick, setSubjectTick] = createSignal(0);

async function loadSubject(repoId: string, oid: string): Promise<void> {
  const key = `${repoId}@${oid}`;
  if (subjects.has(key)) return;
  subjects.set(key, "");
  try {
    subjects.set(key, subjectOf(await ipc.commitMessageLast(repoId)));
  } catch {
    /* an unborn branch or a repo that cannot be read: the line stays empty */
  }
  setSubjectTick((n) => n + 1);
}

/** Opens a repository where the work is: its first change in the diff, else the Commit panel. */
function openRepo(repoId: string): void {
  setToolWindow("left", "commit");
  setPanelOpen(true);
  const target = firstDiffTarget([repoId], snapshots());
  if (target) setSelectedFile(target.repoId, target.path);
}

/** Repo Heartbeat: per repository its branch, ahead/behind, uncommitted changes and the last commit. */
export default function RepoHeartbeat(props: WidgetProps) {
  createEffect(
    on([snapshots, props.refreshTick], () => {
      for (const r of repos()) {
        const oid = snapshots()[r.id]?.head.oid;
        if (oid) void loadSubject(r.id, oid);
      }
    }),
  );
  const subject = (repoId: string) => {
    subjectTick();
    const oid = snapshots()[repoId]?.head.oid;
    return oid ? subjects.get(`${repoId}@${oid}`) ?? "" : "";
  };
  const limit = () => (props.size === "s" ? 4 : props.size === "m" ? 6 : 12);
  return (
    <Show when={workspaceState() === "ready"} fallback={<CardLoading />}>
      <Show when={repos().length > 0} fallback={<CardEmpty icon={FolderGit2} title={t("dash.repos.empty")} why={t("dash.repos.emptyWhy")} />}>
        <ul class="dash-list">
          <For each={repos().slice(0, limit())}>
            {(r) => {
              const snap = () => snapshots()[r.id];
              const dirty = () => snap()?.changes.length ?? 0;
              return (
                <li>
                  <button type="button" class="dash-row dash-repo" onClick={() => openRepo(r.id)} aria-label={t("dash.repos.open", { name: r.name })}>
                    <span class="dash-repo__dot" aria-hidden="true" style={{ background: r.color }} />
                    <span class="dash-repo__name ui-truncate">{r.name}</span>
                    <Show when={snap()} fallback={<Skeleton width={60} height={12} />}>
                      {(s) => (
                        <span class="dash-repo__branch ui-truncate" title={s().head.branch ?? undefined}>
                          {s().head.unborn ? t("dash.repos.unborn") : s().head.detached || !s().head.branch ? t("dash.repos.detached", { oid: s().head.oid?.slice(0, 7) ?? "" }) : s().head.branch}
                        </span>
                      )}
                    </Show>
                    <span class="dash-repo__counts ui-tnum">
                      <Show when={dirty() > 0} fallback={<span class="dash-clean">{t("dash.repos.clean")}</span>}>
                        <span class="dash-dirty">{t("dash.repos.dirty", { n: dirty() })}</span>
                      </Show>
                      <Show when={(snap()?.ahead ?? 0) > 0}>
                        <span>{t("dash.repos.toPush", { n: snap()!.ahead })}</span>
                      </Show>
                      <Show when={(snap()?.behind ?? 0) > 0}>
                        <span>{t("dash.repos.toPull", { n: snap()!.behind })}</span>
                      </Show>
                    </span>
                    <Show when={repoError(r.id) || subject(r.id)}>
                      <span class="dash-repo__last ui-truncate">{repoError(r.id) ? t("dash.repos.unreadable") : subject(r.id)}</span>
                    </Show>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={repos().length > limit()}>
          <p class="dash-hint">{t("dash.repos.more", { n: repos().length - limit() })}</p>
        </Show>
      </Show>
    </Show>
  );
}
