import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { refreshSnapshots } from "../../store/snapshots";
import { adoptWorkspace, saveWorkspace, workspace, workspaceState } from "../../store/workspace";
import { activeId, isPinned, killSurvivor, probeOf, probeWorkspaces, survivors } from "../../store/workspaces";
import { Button, Icon, TriangleAlert } from "../../ui-kit";
import { shortPath } from "./format";
import { locateFlow } from "./flows";

/** Processes of the old workspace that ignored the group kill (4.10 "survivors"): a persistent banner with a Stop it action each. */
export function SurvivorsBanner() {
  return (
    <Show when={survivors().length > 0}>
      <section class="wsbanner" data-tone="warn" role="status" aria-label={t("ws.survivors.banner", { count: survivors().length })}>
        <Icon icon={TriangleAlert} size={16} />
        <div class="wsbanner__body">
          <strong>{t("ws.survivors.banner", { count: survivors().length })}</strong>
          <ul class="wsbanner__list" role="list">
            <For each={survivors()}>
              {(s) => (
                <li>
                  <span class="wsbanner__proc" dir="ltr">
                    {s.kind}
                    {s.port ? `:${s.port}` : ""} · {shortPath(s.cwd)} · {s.pid}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => void killSurvivor(s.pid)}>{t("ws.survivors.kill")}</Button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </section>
    </Show>
  );
}

/**
 * "{n} of {total} folders are missing" above the tree (3.10) with Remove missing, Locate and Dismiss. The data is the cheap
 * probe of the open workspace, repeated when the window regains focus.
 */
export function MissingBanner() {
  const [dismissed, setDismissed] = createSignal("");
  const id = () => activeId();
  const total = () => workspace()?.repos.length ?? 0;
  const missing = createMemo(() => {
    const p = id() ? probeOf(id()!) : undefined;
    return p ? p.repos.filter((r) => r.status !== "ok" && r.status !== "unresponsive").map((r) => r.repoId) : [];
  });
  const key = () => missing().join(",");
  const check = () => {
    const wsId = id();
    if (wsId && !isPinned() && workspaceState() === "ready") void probeWorkspaces([wsId]);
  };
  onMount(() => {
    check();
    window.addEventListener("focus", check);
    onCleanup(() => window.removeEventListener("focus", check));
  });

  async function removeMissing() {
    const ws = workspace();
    if (!ws) return;
    const gone = new Set(missing());
    const repos = ws.repos.filter((r) => !gone.has(r.id)).map((r, order) => ({ ...r, order }));
    await saveWorkspace({ ...ws, repos });
    check();
  }

  async function locate() {
    const wsId = id();
    const first = missing()[0];
    if (!wsId || !first) return;
    if (await locateFlow(wsId, first)) {
      await adoptWorkspace(await ipc.workspaceGet());
      await refreshSnapshots(null);
      check();
    }
  }

  return (
    <Show when={missing().length > 0 && dismissed() !== key() && workspaceState() === "ready"}>
      <section class="wsbanner" data-tone="warn" role="status">
        <Icon icon={TriangleAlert} size={16} />
        <div class="wsbanner__body wsbanner__body--row">
          <strong>{t("ws.banner.missing", { missing: missing().length, total: total() })}</strong>
          <span class="wsbanner__actions">
            <Button size="sm" variant="secondary" onClick={() => void removeMissing()}>{t("ws.banner.removeMissing")}</Button>
            <Button size="sm" variant="secondary" onClick={() => void locate()}>{t("ws.banner.locate")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed(key())}>{t("ws.banner.dismiss")}</Button>
          </span>
        </div>
      </section>
    </Show>
  );
}
