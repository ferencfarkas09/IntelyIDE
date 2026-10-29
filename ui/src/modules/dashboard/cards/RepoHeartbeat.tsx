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
import { AheadBehind, BranchPill, FolderGit2, RepoBadge, Skeleton } from "../../../ui-kit";
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
                  <button type="button" class="dash-row" onClick={() => openRepo(r.id)} aria-label={t("dash.repos.open", { name: r.name })}>
                    <RepoBadge color={r.color} badge={r.badge} size={20} />
                    <span class="dash-row__main">
                      <span class="dash-row__title">
                        <span class="ui-truncate">{r.name}</span>
                        <Show when={snap()} fallback={<Skeleton width={60} height={12} />}>
                          {(s) => <BranchPill name={s().head.branch ?? undefined} detached={s().head.detached} unborn={s().head.unborn} oid={s().head.oid?.slice(0, 7)} />}
                        </Show>
                      </span>
                      <span class="dash-row__sub ui-truncate">{repoError(r.id) ? t("dash.repos.unreadable") : subject(r.id) || " "}</span>
                    </span>
                    <span class="dash-row__end ui-tnum">
                      <Show when={snap()}>{(s) => <AheadBehind ahead={s().ahead} behind={s().behind} />}</Show>
                      <Show when={dirty() > 0} fallback={<span class="dash-clean">{t("dash.repos.clean")}</span>}>
                        <span class="dash-dirty">{t("dash.repos.dirty", { n: dirty() })}</span>
                      </Show>
                    </span>
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
