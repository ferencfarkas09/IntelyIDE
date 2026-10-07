import { createResource, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { repos } from "../../store/workspace";
import { Archive, Button, EmptyState, Icon, IconButton, Input, RepoBadge, Spinner, Trash2 } from "../../ui-kit";
import { stashAction, stashTargets, stashTicked } from "./actions";
import { relativeTime, rollbackCount } from "./logic";
import { branchesRev, openDialog } from "./uiState";
import "./branches.css";

/** The Stash tab of the Commit tool window: every repo's stashes, and a way to stash the ticked files. */
export default function StashPanel() {
  const [groups] = createResource(
    () => [repos().map((r) => r.id).join(), branchesRev()] as const,
    () => Promise.all(repos().map(async (repo) => ({ repo, entries: await ipc.branches.stashList(repo.id) }))),
  );
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const ticked = () => rollbackCount(stashTargets());
  const shown = () => (groups() ?? []).filter((g) => g.entries.length > 0);

  const stash = async () => {
    setBusy("push");
    await stashTicked(message());
    setMessage("");
    setBusy(null);
  };
  const act = async (kind: "apply" | "pop", repoId: string, index: number) => {
    setBusy(`${repoId}:${index}`);
    await stashAction(kind, repoId, index);
    setBusy(null);
  };

  return (
    <section class="stp" aria-label={t("stash.label")}>
      <form class="stp__push" onSubmit={(e) => (e.preventDefault(), ticked() > 0 && void stash())}>
        <Input size="sm" aria-label={t("stash.messageLabel")} placeholder={t("stash.messagePh")} autocomplete="off" value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
        <Button type="submit" size="sm" variant="secondary" icon={Archive} disabled={ticked() === 0} loading={busy() === "push"} title={ticked() === 0 ? t("stash.tickTip") : undefined}>
          {ticked() === 0 ? t("stash.btnNone") : t("stash.btn", { count: ticked() })}
        </Button>
      </form>
      <div class="stp__list">
        <Show when={!groups.loading || groups()} fallback={<div class="bpl__loading"><Spinner size={16} label={t("stash.loading")} /></div>}>
          <Show when={shown().length > 0} fallback={<EmptyState size="sm" icon={Archive} title={t("stash.none")} description={t("stash.noneDesc")} />}>
            <For each={shown()}>
              {(g) => (
                <div class="stp__group">
                  <div class="stp__repo">
                    <RepoBadge color={g.repo.color} badge={g.repo.badge} size={16} />
                    <span class="ui-truncate">{g.repo.name}</span>
                  </div>
                  <For each={g.entries}>
                    {(s) => (
                      <div class="stp__row">
                        <Icon icon={Archive} size={14} class="stp__icon" />
                        <div class="stp__main">
                          <span class="stp__msg ui-truncate" title={s.message}>
                            {s.message}
                          </span>
                          <span class="stp__meta ui-truncate">
                            {s.branch ? `${t("stash.onBranch", { branch: s.branch })} · ` : ""}
                            {relativeTime(s.createdMs, Date.now())} · stash@{`{${s.index}}`}
                          </span>
                        </div>
                        <span class="stp__acts">
                          <Button size="sm" variant="ghost" disabled={busy() === `${g.repo.id}:${s.index}`} onClick={() => void act("apply", g.repo.id, s.index)}>
                            {t("stash.apply")}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy() === `${g.repo.id}:${s.index}`} onClick={() => void act("pop", g.repo.id, s.index)}>
                            {t("stash.pop")}
                          </Button>
                          <IconButton icon={Trash2} label={t("stash.dropLabel", { index: s.index, repo: g.repo.name })} tooltip={t("stash.dropTip")} size="sm" onClick={() => openDialog({ kind: "stashDrop", repoId: g.repo.id, index: s.index, message: s.message })} />
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </section>
  );
}
