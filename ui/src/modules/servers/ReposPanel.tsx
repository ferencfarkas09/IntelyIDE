import { createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { RepoState, ServerView } from "../../ipc/servers";
import { repoConfig, repos } from "../../store/workspace";
import { Badge, Button, Spinner, toast } from "../../ui-kit";
import { missingRepoIds, repoKind } from "./logic";
import { messageOf, repoStates } from "./store";

/** The workspace repositories on one server: which are there, on what branch, and a button to clone the missing ones. */
export function ReposPanel(props: { view: ServerView }) {
  const id = () => props.view.cfg.id;
  const ids = () => repos().map((r) => r.id);
  const [states, setStates] = createSignal<RepoState[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [cloning, setCloning] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const missing = () => missingRepoIds(ids(), states());
  const label = (i: number) => repoConfig(ids()[i])?.name ?? states()[i]?.name ?? ids()[i];

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

  return (
    <section class="srv-panel" aria-label={t("servers.repos.title", { name: props.view.cfg.name })}>
      <h5 class="srv-panel__title">{t("servers.repos.title", { name: props.view.cfg.name })}</h5>
      <Show when={ids().length > 0} fallback={<p class="srv-form__note">{t("servers.repos.none")}</p>}>
        <Show when={!loading() || states().length > 0} fallback={<span class="srv-check"><Spinner size={14} label={t("servers.repos.loading")} /> {t("servers.repos.loading")}</span>}>
          <Show when={!error()} fallback={<p class="srv-card__error" role="alert">{error()}</p>}>
            <ul class="srv-repos">
              <For each={states()}>
                {(s, i) => (
                  <li class="srv-repo" data-kind={repoKind(s)}>
                    <span class="srv-repo__name">{label(i())}</span>
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
                    <span class="srv-repo__path">{s.path}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <div class="srv-actions">
          <Button size="sm" variant="secondary" loading={cloning()} disabled={missing().length === 0 || loading()} onClick={() => void cloneMissing()}>
            {t("servers.repos.cloneMissing")}
          </Button>
          <Button size="sm" variant="ghost" disabled={cloning() || loading()} onClick={() => void load()}>
            {t("servers.repos.refresh")}
          </Button>
        </div>
        <p class="srv-form__note">{t("servers.repos.cloneNote")}</p>
      </Show>
    </section>
  );
}
