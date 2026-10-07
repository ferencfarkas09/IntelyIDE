import { createResource, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { OpOutcome } from "../../ipc/graph";
import { refreshSnapshots, snapshots } from "../../store/snapshots";
import { repoConfig, repos } from "../../store/workspace";
import { Badge, Button, GitMerge, toast } from "../../ui-kit";
import { reloadLog, shownRepoIds } from "./logState";
import { describeOp, errorMessage, opBlocked } from "./ops";
import { openRebase } from "./rebaseState";

/** Rebases and cherry-picks that stopped, in the shown repos: continue or abort them from the Log. */
export function OpBanner() {
  const heads = () => repos().map((r) => snapshots()[r.id]?.head.oid ?? "").join(",");
  const [ops, { refetch }] = createResource(
    () => ({ ids: shownRepoIds(), heads: heads() }),
    async ({ ids }) => (await Promise.all(ids.map((id) => ipc.graph.opState(id).catch(() => null)))).filter((o): o is OpOutcome => !!o && opBlocked(o)),
  );

  const act = async (o: OpOutcome, what: "continue" | "abort") => {
    try {
      const call = o.kind === "rebase" ? (what === "continue" ? ipc.graph.rebaseContinue : ipc.graph.rebaseAbort) : what === "continue" ? ipc.graph.cherryPickContinue : ipc.graph.cherryPickAbort;
      const next = await call(o.repoId);
      if (what === "continue" && opBlocked(next)) toast.warn(describeOp(next));
    } catch (err) {
      toast.error(what === "continue" ? t("graph.op.continueFail") : t("graph.op.abortFail"), errorMessage(err));
    }
    await Promise.all([refreshSnapshots(o.repoId), reloadLog(), refetch()]);
  };

  return (
    <Show when={(ops() ?? []).length > 0}>
      <div class="glog__ops" role="alert">
        <For each={ops()}>
          {(o) => (
            <div class="glog__op">
              <Badge tone="danger" icon={GitMerge} size="sm">{repoConfig(o.repoId)?.name ?? o.repoId}</Badge>
              <span class="glog__op-text ui-truncate" title={o.conflictFiles.join(", ")}>{describeOp(o)}</span>
              <Show when={o.kind === "rebase"}><Button size="sm" variant="ghost" onClick={() => openRebase(o.repoId)}>{t("graph.op.open")}</Button></Show>
              <Button size="sm" variant="primary" onClick={() => void act(o, "continue")}>{t("graph.op.continue")}</Button>
              <Button size="sm" variant="ghost" onClick={() => void act(o, "abort")}>{t("graph.op.abort")}</Button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
