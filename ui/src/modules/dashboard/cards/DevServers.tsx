import { For, Show } from "solid-js";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import type { ServerInfo } from "../../../ipc/run";
import { setToolWindow } from "../../../platform/rail";
import type { WidgetProps } from "../../../platform/widgets";
import { devServers, formatRss, isLive, totalRssMb } from "../../../store/devservers";
import { repoConfig } from "../../../store/workspace";
import { Button, ExternalLink, IconButton, Play, RotateCw, Server, Square, StatusDot, toast } from "../../../ui-kit";
import { CardEmpty, errorText } from "../parts";

const TONE = { starting: "info", running: "ok", stopping: "warn", exited: "neutral", failed: "danger" } as const;
const STATUS_KEY = { starting: "dash.servers.starting", running: "dash.servers.running", stopping: "dash.servers.stopping", exited: "dash.servers.exited", failed: "dash.servers.failed" } as const;

const act = (fn: () => Promise<unknown>) => void fn().catch((e) => toast.error(t("dash.servers.failedAction"), errorText(e)));
const showRunPanel = () => setToolWindow("bottom", "run");

/** Dev servers: what the Run panel started, with ports and memory, and stop / restart through the same commands as the panel. */
export default function DevServers(props: WidgetProps) {
  const limit = () => (props.size === "s" ? 3 : props.size === "m" ? 5 : 10);
  return (
    <Show
      when={devServers().length > 0}
      fallback={
        <CardEmpty
          icon={Server}
          title={t("dash.servers.empty")}
          why={t("dash.servers.emptyWhy")}
          action={
            <Button size="sm" variant="secondary" icon={Play} onClick={showRunPanel}>
              {t("dash.servers.openRun")}
            </Button>
          }
        />
      }
    >
      <ul class="dash-list">
        <For each={devServers().slice(0, limit())}>
          {(s: ServerInfo) => (
            <li class="dash-row dash-row--static">
              <StatusDot tone={TONE[s.status]} pulse={s.status === "starting"} label={t(STATUS_KEY[s.status])} />
              <span class="dash-row__main">
                <span class="dash-row__title">
                  <span class="ui-truncate">{s.script}</span>
                </span>
                <span class="dash-row__sub ui-truncate ui-tnum">
                  {repoConfig(s.repoId)?.name ?? s.repoId}
                  <Show when={s.ports.length > 0}> · :{s.ports.join(", :")}</Show>
                  <Show when={isLive(s) && s.rssMb != null}> · {formatRss(s.rssMb)}</Show>
                </span>
              </span>
              <span class="dash-row__end">
                <Show when={s.url && s.status === "running"}>
                  <IconButton size="sm" icon={ExternalLink} label={t("dash.servers.open")} onClick={() => act(() => ipc.run.open(s.id))} />
                </Show>
                <Show
                  when={isLive(s)}
                  fallback={<IconButton size="sm" icon={RotateCw} label={t("dash.servers.restart")} onClick={() => act(() => ipc.run.restart(s.id))} />}
                >
                  <IconButton size="sm" icon={Square} label={t("dash.servers.stop")} disabled={s.status === "stopping"} onClick={() => act(() => ipc.run.stop(s.id))} />
                </Show>
              </span>
            </li>
          )}
        </For>
      </ul>
      <p class="dash-hint ui-tnum">{t("dash.servers.total", { mem: formatRss(totalRssMb()) })}</p>
      <div class="dash-actions">
        <Button size="sm" variant="ghost" onClick={showRunPanel}>
          {t("dash.servers.openRun")}
        </Button>
      </div>
    </Show>
  );
}
