import { createEffect, createMemo, createResource, For, Show } from "solid-js";
import { repoName } from "../../store/actions";
import { checkedFiles } from "../../store/selection";
import { touchedByAgent } from "../../store/touched";
import { workspace } from "../../store/workspace";
import { t } from "../../i18n";
import { Badge, Bot, Icon, IconButton, RepoBadge, Tooltip, TriangleAlert, X } from "../../ui-kit";
import { splitPath } from "../push/logic";
import "./commit.css";
import { dismissExecWarning, findExecSurface, hasUndismissed, resetExecDismissal, type ExecFile } from "./execSurface";

/** The files grouped by repo (workspace order), each with the repo badge, its path and an extra mark when an agent run changed it. */
export function ExecFileGroups(props: { files: readonly ExecFile[] }) {
  const groups = createMemo(() => {
    const order = (workspace()?.repos ?? []).map((r) => r.id);
    const ids = [...new Set(props.files.map((f) => f.repoId))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    return ids.map((id) => ({ id, files: props.files.filter((f) => f.repoId === id) }));
  });
  return (
    <div class="exec-warn__groups">
      <For each={groups()}>
        {(g) => {
          const repo = () => workspace()?.repos.find((r) => r.id === g.id);
          return (
            <section class="exec-warn__group" data-repo={g.id}>
              <header class="exec-warn__repo">
                <Show when={repo()}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}</Show>
                <span class="ui-truncate">{repoName(g.id)}</span>
              </header>
              <ul class="exec-warn__files" aria-label={repoName(g.id)}>
                <For each={g.files}>
                  {(f) => (
                    <li class="exec-warn__file">
                      <span class="ui-mono ui-truncate" title={f.path}>
                        {splitPath(f.path).name}
                      </span>
                      <Show when={splitPath(f.path).dir}>
                        <span class="ui-path-hint ui-truncate">{splitPath(f.path).dir}</span>
                      </Show>
                      <Show when={touchedByAgent(f.repoId, f.path)}>
                        {(touch) => (
                          <Tooltip label={t("changes.agentChanged", { role: touch().role })}>
                            <Badge tone="warn" size="sm" icon={Bot} class="exec-warn__agent">
                              {t("commit.exec.byAgent")}
                            </Badge>
                          </Tooltip>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          );
        }}
      </For>
    </div>
  );
}

/**
 * Non-blocking warning above the Commit button: some ticked file runs code when you commit, push, install, lint, test or build.
 * Core safety feature, not a module slot. Dismissing hides it for the files shown; a new such file brings it back.
 */
export function ExecSurfaceBanner() {
  const ticked = createMemo(() => (workspace()?.repos ?? []).map((r) => ({ repoId: r.id, paths: checkedFiles(r.id) })).filter((r) => r.paths.length > 0));
  const [found] = createResource(
    () => (ticked().length ? ticked() : false),
    (repos) => findExecSurface(repos),
  );
  const files = () => found.latest ?? [];
  // A new commit attempt starts from nothing ticked: earlier dismissals no longer apply.
  createEffect(() => {
    if (!ticked().length) resetExecDismissal();
  });
  return (
    <Show when={files().length > 0 && hasUndismissed(files())}>
      <div class="exec-warn" role="status" aria-label={t("commit.exec.aria")}>
        <div class="exec-warn__head">
          <Icon icon={TriangleAlert} size={14} />
          <p class="exec-warn__title">{t("commit.exec.title", { n: files().length })}</p>
          <IconButton icon={X} size="sm" label={t("commit.exec.dismiss")} onClick={() => dismissExecWarning(files())} />
        </div>
        <ExecFileGroups files={files()} />
      </div>
    </Show>
  );
}
