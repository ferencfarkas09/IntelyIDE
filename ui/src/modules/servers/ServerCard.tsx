import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ServerView } from "../../ipc/servers";
import { Badge, Button, Circle, CircleAlert, CircleCheck, Copy, Download, FolderGit2, Icon, Pencil, RefreshCw, Server, Trash2, toast } from "../../ui-kit";
import { ReposPanel } from "./ReposPanel";
import { SetupPanel } from "./SetupPanel";
import { checklist, loginCommand, needsClaudeLogin, platformText, setupLabelId, statusChip } from "./logic";
import { isProbing, messageOf, probeServer, setupOf } from "./store";

const CHECK_ICON = { ok: CircleCheck, missing: CircleAlert, unknown: Circle } as const;
type Panel = "setup" | "repos" | undefined;

export function ServerCard(props: { view: ServerView; onEdit: () => void; onDelete: () => void }) {
  const v = () => props.view;
  const status = () => v().status;
  const chip = () => statusChip(status());
  const [panel, setPanel] = createSignal<Panel>(undefined);
  const [probeError, setProbeError] = createSignal<string | undefined>(undefined);
  const toggle = (p: Exclude<Panel, undefined>) => setPanel(panel() === p ? undefined : p);

  const test = async () => setProbeError(await probeServer(v().cfg.id));
  const copySsh = async () => {
    try {
      const cmd = await ipc.servers.sshCommand(v().cfg.id);
      if (!navigator.clipboard) throw new Error(t("servers.copy.noClipboard"));
      await navigator.clipboard.writeText(cmd);
      toast.success(t("servers.copy.done"), cmd);
    } catch (e) {
      toast.error(t("servers.copy.failed"), messageOf(e));
    }
  };

  return (
    <li class="srv-card" aria-label={v().cfg.name} data-disabled={v().cfg.enabled ? undefined : ""} data-chip={chip().id}>
      <div class="srv-card__head">
        <Icon icon={Server} size={16} class="srv-card__icon" />
        <h4 class="srv-card__name">{v().cfg.name}</h4>
        <span class="srv-card__dest">{v().cfg.port ? `${v().cfg.destination}:${v().cfg.port}` : v().cfg.destination}</span>
        <span class="srv-card__grow" />
        <Show when={!v().cfg.enabled}>
          <Badge size="sm">{t("servers.disabled")}</Badge>
        </Show>
        <Badge class="srv-chip" tone={chip().tone}>{t(`servers.chip.${chip().id}` as const)}</Badge>
      </div>
      <p class="srv-card__meta">
        <Show when={platformText(status())}>
          <span>{platformText(status())}</span>
        </Show>
        <span>{t("servers.capacity", { running: v().running, max: v().cfg.maxAgents })}</span>
        <span>{t("servers.root", { root: v().cfg.root })}</span>
      </p>
      <Show when={status()?.error}>
        {(e) => (
          <p class="srv-card__error" role="status">
            {e().message}
            <Show when={e().hint}>
              <span class="srv-card__hint">{e().hint}</span>
            </Show>
          </p>
        )}
      </Show>
      <Show when={probeError()}>{(m) => <p class="srv-card__error" role="alert">{m()}</p>}</Show>
      <Show when={status()?.reachable}>
        <ul class="srv-checks" aria-label={t("servers.checks")}>
          <For each={checklist(status())}>
            {(c) => (
              <li class="srv-check" data-state={c.state} data-check={c.id}>
                <Icon icon={CHECK_ICON[c.state]} size={14} />
                <span>{t(`servers.check.${c.id}` as const)}</span>
                <span class="srv-check__ver">{c.state === "ok" ? (c.version ?? t("servers.check.installed")) : t(`servers.check.${c.state}` as const)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={needsClaudeLogin(status())}>
        <p class="srv-notice" role="note">
          {t("servers.loginNotice")} <code>{loginCommand(v().cfg)}</code>
        </p>
      </Show>
      <div class="srv-actions">
        <Button size="sm" variant="secondary" icon={RefreshCw} loading={isProbing(v().cfg.id)} onClick={() => void test()}>
          {t("servers.test")}
        </Button>
        <Button size="sm" variant="secondary" icon={Download} aria-expanded={panel() === "setup"} loading={setupOf(v().cfg.id)?.running === true} onClick={() => toggle("setup")}>
          {t(setupLabelId(status()) === "update" ? "servers.update" : "servers.setUp")}
        </Button>
        <Button size="sm" variant="secondary" icon={FolderGit2} aria-expanded={panel() === "repos"} onClick={() => toggle("repos")}>
          {t("servers.repos.button")}
        </Button>
        <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copySsh()}>
          {t("servers.copy.button")}
        </Button>
        <span class="srv-actions__sep" />
        <Button size="sm" variant="ghost" icon={Pencil} onClick={props.onEdit}>
          {t("servers.edit")}
        </Button>
        <Button size="sm" variant="ghost" icon={Trash2} onClick={props.onDelete}>
          {t("servers.delete")}
        </Button>
      </div>
      <Show when={panel() === "setup"}>
        <SetupPanel view={v()} />
      </Show>
      <Show when={panel() === "repos"}>
        <ReposPanel view={v()} />
      </Show>
    </li>
  );
}
