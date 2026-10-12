import { createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { FoundRow, RepoRow, ServerView } from "../../ipc/servers";
import { repoConfig, repos } from "../../store/workspace";
import { Badge, Button, Input, Spinner, toast } from "../../ui-kit";
import { initialChoices, missingRepoIds, pathSource, repoKind, validateRepoPath } from "./logic";
import { findRepos, messageOf, repoStates, setRepoPath } from "./store";

/**
 * The workspace repositories on one server: where each is looked for (the default `<root>/<folder name>` or a folder set for it), what is
 * there, a search of the server for the folders, and a button to clone the missing ones.
 */
export function ReposPanel(props: { view: ServerView }) {
  const id = () => props.view.cfg.id;
  const ids = () => repos().map((r) => r.id);
  const [states, setStates] = createSignal<RepoRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [cloning, setCloning] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [editing, setEditing] = createSignal<string | undefined>(undefined);
  const [draft, setDraft] = createSignal("");
  const [draftError, setDraftError] = createSignal<string | undefined>(undefined);
  const [saving, setSaving] = createSignal(false);
  const [finding, setFinding] = createSignal(false);
  const [found, setFound] = createSignal<FoundRow[] | undefined>(undefined);
  const [choices, setChoices] = createSignal<Record<string, string>>({});
  const missing = () => missingRepoIds(ids(), states());
  const nameOf = (r: RepoRow) => repoConfig(r.repoId)?.name ?? r.name;
  const busy = () => cloning() || loading() || saving() || finding();

  const load = async () => {
    setLoading(true);
    try {
      setStates(await repoStates(id(), ids()));
      setError(undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void load());

  const cloneMissing = async () => {
    setCloning(true);
    const failures: string[] = [];
    for (const repoId of missing()) {
      try {
        await ipc.servers.clone(id(), repoId);
      } catch (e) {
        failures.push(`${repoConfig(repoId)?.name ?? repoId}: ${messageOf(e)}`);
      }
    }
    setCloning(false);
    if (failures.length > 0) toast.error(t("servers.repos.cloneFailed", { count: failures.length }), failures.join("\n"));
    await load();
  };

  const startEdit = (r: RepoRow) => {
    setEditing(r.repoId);
    setDraft(r.path || r.defaultPath || "");
    setDraftError(undefined);
  };

  /** Saves one folder (`null` = back to the default); the backend checks it again. */
  const save = async (r: RepoRow, path: string | null) => {
    setSaving(true);
    try {
      await setRepoPath(id(), r.key, path);
      setEditing(undefined);
      await load();
    } catch (e) {
      toast.error(t("servers.repos.saveFailed"), messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  const submitEdit = (r: RepoRow) => {
    const bad = validateRepoPath(draft());
    if (bad) return setDraftError(t(bad));
    const next = draft().trim().replace(/(.)\/+$/, "$1");
    void save(r, r.defaultPath !== undefined && next === r.defaultPath ? null : next);
  };

  const find = async () => {
    setFinding(true);
    setFound(undefined);
    try {
      const rows = await findRepos(id(), ids());
      setChoices(initialChoices(rows, states()));
      setFound(rows);
    } catch (e) {
      toast.error(t("servers.repos.findFailed"), messageOf(e));
    } finally {
      setFinding(false);
    }
  };

  const chosenCount = () => Object.keys(choices()).length;
  /** Saves the folders the person confirmed, one by one; nothing was saved before this. */
  const saveChoices = async () => {
    setSaving(true);
    const failures: string[] = [];
    for (const row of found() ?? []) {
      const path = choices()[row.repoId];
      if (!path) continue;
      try {
        await setRepoPath(id(), row.key, path);
      } catch (e) {
        failures.push(`${repoConfig(row.repoId)?.name ?? row.repoId}: ${messageOf(e)}`);
      }
    }
    setSaving(false);
    if (failures.length > 0) toast.error(t("servers.repos.saveFailed"), failures.join("\n"));
    else setFound(undefined);
    await load();
  };

  const labelOf = (repoId: string) => repoConfig(repoId)?.name ?? states().find((s) => s.repoId === repoId)?.name ?? repoId;

  return (
    <section class="srv-panel" aria-label={t("servers.repos.title", { name: props.view.cfg.name })}>
      <h5 class="srv-panel__title">{t("servers.repos.title", { name: props.view.cfg.name })}</h5>
      <Show when={ids().length > 0} fallback={<p class="srv-form__note">{t("servers.repos.none")}</p>}>
        <Show when={!loading() || states().length > 0} fallback={<span class="srv-check"><Spinner size={14} label={t("servers.repos.loading")} /> {t("servers.repos.loading")}</span>}>
          <Show when={!error()} fallback={<p class="srv-card__error" role="alert">{error()}</p>}>
            <ul class="srv-repos">
              <For each={states()}>
                {(s) => (
                  <li class="srv-repo" data-kind={repoKind(s)}>
                    <span class="srv-repo__name">{nameOf(s)}</span>
                    <Show when={repoKind(s) === "ready"}>
                      <Badge size="sm" tone="ok">{s.branch ?? t("servers.repos.ready")}</Badge>
                      <Show when={s.dirty}>
                        <Badge size="sm" tone="warn">{t("servers.repos.dirty")}</Badge>
                      </Show>
                    </Show>
                    <Show when={repoKind(s) === "notGit"}>
                      <Badge size="sm" tone="warn">{t("servers.repos.notGit")}</Badge>
                    </Show>
                    <Show when={repoKind(s) === "missing"}>
                      <Badge size="sm">{t("servers.repos.missing")}</Badge>
                    </Show>
                    <Badge size="sm" tone={s.mapped ? "accent" : "neutral"}>{t(`servers.repos.source.${pathSource(s)}`)}</Badge>
                    <span class="srv-repo__path">{s.path || t("servers.repos.noDefault")}</span>
                    <Show when={editing() !== s.repoId}>
                      <span class="srv-repo__actions">
                        <Button size="sm" variant="ghost" disabled={busy()} aria-label={t("servers.repos.editFor", { name: nameOf(s) })} onClick={() => startEdit(s)}>
                          {t("servers.repos.edit")}
                        </Button>
                        <Show when={s.mapped}>
                          <Button size="sm" variant="ghost" disabled={busy()} aria-label={t("servers.repos.resetFor", { name: nameOf(s) })} onClick={() => void save(s, null)}>
                            {t("servers.repos.reset")}
                          </Button>
                        </Show>
                      </span>
                    </Show>
                    <Show when={editing() === s.repoId}>
                      <form
                        class="srv-repo__edit"
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          submitEdit(s);
                        }}
                      >
                        <Input
                          size="sm"
                          data-autofocus
                          aria-label={t("servers.repos.folderFor", { name: nameOf(s), server: props.view.cfg.name })}
                          value={draft()}
                          invalid={!!draftError()}
                          placeholder="~/code/orders-api"
                          spellcheck={false}
                          autocomplete="off"
                          autocapitalize="off"
                          onInput={(e) => (setDraft(e.currentTarget.value), setDraftError(undefined))}
                        />
                        <Button size="sm" variant="primary" type="submit" loading={saving()}>{t("servers.repos.save")}</Button>
                        <Button size="sm" variant="ghost" type="button" disabled={saving()} onClick={() => setEditing(undefined)}>{t("servers.repos.cancel")}</Button>
                        <span class="srv-form__note" role={draftError() ? "alert" : undefined} classList={{ "srv-err": !!draftError() }}>{draftError() ?? t("servers.repos.pathHint")}</span>
                      </form>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <div class="srv-actions">
          <Button size="sm" variant="secondary" loading={cloning()} disabled={missing().length === 0 || loading() || saving() || finding()} onClick={() => void cloneMissing()}>
            {t("servers.repos.cloneMissing")}
          </Button>
          <Button size="sm" variant="secondary" loading={finding()} disabled={busy() || !!error()} onClick={() => void find()}>
            {t("servers.repos.find")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy()} onClick={() => void load()}>
            {t("servers.repos.refresh")}
          </Button>
        </div>
        <Show when={finding()}>
          <span class="srv-check"><Spinner size={14} label={t("servers.repos.finding")} /> {t("servers.repos.finding")}</span>
        </Show>
        <Show when={found()}>
          {(rows) => (
            <div class="srv-found" role="group" aria-label={t("servers.repos.foundTitle")}>
              <h6 class="srv-panel__title">{t("servers.repos.foundTitle")}</h6>
              <ul class="srv-repos">
                <For each={rows()}>
                  {(row) => (
                    <li class="srv-repo" data-found={row.candidates.length === 0 ? "none" : row.candidates.length === 1 ? "one" : "many"}>
                      <span class="srv-repo__name">{labelOf(row.repoId)}</span>
                      <Show when={row.candidates.length === 0}>
                        <Badge size="sm">{t("servers.repos.foundNone")}</Badge>
                      </Show>
                      <Show when={row.candidates.length > 1}>
                        <Badge size="sm" tone="warn">{t("servers.repos.foundMany", { count: row.candidates.length })}</Badge>
                      </Show>
                      <Show when={row.candidates.length > 0}>
                        <div class="srv-found__choices" role="radiogroup" aria-label={labelOf(row.repoId)}>
                          <For each={row.candidates}>
                            {(c) => {
                              const current = () => states().find((s) => s.repoId === row.repoId)?.path === c.path;
                              return (
                                <label class="srv-found__choice">
                                  <input
                                    type="radio"
                                    name={`found-${row.repoId}`}
                                    checked={choices()[row.repoId] === c.path}
                                    disabled={saving()}
                                    onChange={() => setChoices({ ...choices(), [row.repoId]: c.path })}
                                  />
                                  <span class="srv-repo__path">{c.path}</span>
                                  <Show when={current()}>
                                    <Badge size="sm" tone="ok">{t("servers.repos.alreadySet")}</Badge>
                                  </Show>
                                </label>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <div class="srv-actions">
                <Button size="sm" variant="primary" disabled={chosenCount() === 0 || saving()} loading={saving()} onClick={() => void saveChoices()}>
                  {t("servers.repos.saveFound", { count: chosenCount() })}
                </Button>
                <Button size="sm" variant="ghost" disabled={saving()} onClick={() => setFound(undefined)}>
                  {t("servers.repos.dismiss")}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <p class="srv-form__note">{t("servers.repos.cloneNote")}</p>
        <p class="srv-form__note">{t("servers.repos.findNote")}</p>
      </Show>
    </section>
  );
}
