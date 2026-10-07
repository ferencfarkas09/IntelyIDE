import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { openSettings } from "../../platform/settings";
import { setToolWindow } from "../../platform/rail";
import { devServers, formatRss, heavyServers, isLive, liveServers } from "../../store/devservers";
import {
  Badge, Button, ChevronDown, ChevronRight, Dialog, EmptyState, ExternalLink, Icon, IconButton, Input, Play, RepoBadge, RotateCw, Search, ShieldAlert, Square, StatusDot, Trash2, Tooltip, X,
} from "../../ui-kit";
import type { ScriptGroup, ScriptInfo, ServerInfo } from "../../ipc/run";
import { highlight, parseAnsi } from "./ansi";
import { COLLAPSED_BY_DEFAULT, groupScripts, heapLabel, searchLines, serverId, statusLabel, statusTone } from "./logic";
import {
  cancelPending, catalogState, clearLog, confirmPending, currentRepoId, dismissServer, logOf, openServer, pendingStart, processAccess, refreshAccess, repoList, requestStart, restartServer, revealedCommand,
  filterFocusTick, selectedServerId, selectRepo, selectServer, stopAll, stopServer, toggleCommand, wire,
} from "./store";
import "./run.css";

const RENDER_CAP = 1500;

function ScriptRow(props: { repoId: string; script: ScriptInfo }) {
  const server = (): ServerInfo | undefined => devServers().find((s) => s.id === serverId(props.repoId, props.script.id));
  const live = () => !!server() && isLive(server()!);
  const blocked = () => processAccess() && !processAccess()!.startable;
  const command = () => revealedCommand(`${props.repoId}:${props.script.id}`);
  return (
    <div class="run-script" data-running={live() ? "" : undefined} data-selected={selectedServerId() === serverId(props.repoId, props.script.id) ? "" : undefined}>
      <div class="run-script__main" onClick={() => server() && selectServer(server()!.id)}>
        <Show
          when={live()}
          fallback={
            <IconButton
              icon={Play}
              label={t("run.runLabel", { runner: props.script.runner })}
              tooltip={blocked() ? t("run.blockedTip") : t("run.runLabel", { runner: props.script.runner })}
              size="sm"
              disabled={blocked()}
              onClick={(e) => (e.stopPropagation(), requestStart(props.repoId, props.script))}
            />
          }
        >
          <IconButton icon={Square} label={t("run.stopLabel", { runner: props.script.runner })} size="sm" variant="secondary" onClick={(e) => (e.stopPropagation(), stopServer(server()!.id))} />
        </Show>
        <div class="run-script__text">
          <span class="run-script__name ui-truncate">{props.script.name}</span>
          <span class="run-script__meta">
            <Show when={props.script.heavyMb}>{(mb) => <Badge tone="warn" size="sm" title={t("run.heavyTip")}>{heapLabel(mb())}</Badge>}</Show>
            <Show when={props.script.safety === "confirm"}>
              <Tooltip label={t("run.confirmTip", { reasons: props.script.reasons.join(", ") })}>
                <span class="run-script__confirm"><Icon icon={ShieldAlert} size={12} />{t("run.confirm")}</span>
              </Tooltip>
            </Show>
            <Show when={props.script.envNames.length}>
              <span class="run-script__env ui-truncate" title={t("run.envTip")}>{t("run.env", { names: props.script.envNames.join(", ") })}</span>
            </Show>
          </span>
        </div>
        <Show when={server()}>
          {(s) => (
            <span class="run-script__state">
              <StatusDot tone={statusTone(s())} pulse={s().status === "starting" || s().status === "stopping"} label={statusLabel(s().status)} />
              <Show when={s().ports[0]}>{(port) => <span class="run-chip ui-tnum">:{port()}</span>}</Show>
              <Show when={isLive(s()) && s().rssMb != null}><span class="run-script__rss ui-tnum">{formatRss(s().rssMb)}</span></Show>
              <Show when={!isLive(s())}><span class="run-script__rss">{s().exitCode ? t("run.exit", { code: s().exitCode }) : t("run.stopped")}</span></Show>
            </span>
          )}
        </Show>
        <Tooltip label={command() === undefined ? t("run.showCommand") : t("run.hideCommand")}>
          <button type="button" class="run-script__peek" aria-label={command() === undefined ? t("run.showCommandOf", { name: props.script.name }) : t("run.hideCommandOf", { name: props.script.name })} aria-expanded={command() !== undefined} onClick={(e) => (e.stopPropagation(), toggleCommand(props.repoId, props.script))}>
            <Icon icon={ChevronDown} size={12} />
          </button>
        </Tooltip>
      </div>
      <Show when={command() !== undefined}>
        <code class="run-script__command">{command()}</code>
      </Show>
    </div>
  );
}

function ScriptList(props: { repoId: string; filter: string }) {
  const state = () => catalogState(props.repoId);
  const [open, setOpen] = createSignal<Partial<Record<ScriptGroup, boolean>>>({});
  const isOpen = (g: ScriptGroup, filtering: boolean) => filtering || (open()[g] ?? !COLLAPSED_BY_DEFAULT.includes(g));
  const catalog = () => {
    const s = state();
    return typeof s === "object" && "catalog" in s ? s.catalog : undefined;
  };
  const groups = createMemo(() => groupScripts(catalog()?.scripts ?? [], props.filter));
  return (
    <div class="run-list" role="list" aria-label={t("run.scripts")}>
      <Show when={state() === "loading" || state() === undefined}><div class="run-note">{t("run.reading")}</div></Show>
      <Show when={typeof state() === "object" && "error" in (state() as object)}>
        <EmptyState size="sm" tone="danger" title={t("run.noScripts")} description={(state() as { error: string }).error} />
      </Show>
      <Show when={catalog()}>
        {(c) => (
          <>
            <For each={c().notes}>{(n) => <div class="run-note">{n}</div>}</For>
            <For each={groups()} fallback={<div class="run-note">{props.filter.trim() ? t("run.noMatch", { filter: props.filter }) : t("run.noScripts")}</div>}>
              {(g) => (
                <section class="run-group">
                  <button type="button" class="run-group__head" aria-expanded={isOpen(g.group, !!props.filter)} onClick={() => setOpen((o) => ({ ...o, [g.group]: !isOpen(g.group, false) }))}>
                    <Icon icon={isOpen(g.group, !!props.filter) ? ChevronDown : ChevronRight} size={12} />
                    <span>{g.label}</span>
                    <span class="run-group__count ui-tnum">{g.scripts.length}</span>
                  </button>
                  <Show when={isOpen(g.group, !!props.filter)}>
                    <For each={g.scripts}>{(s) => <ScriptRow repoId={props.repoId} script={s} />}</For>
                  </Show>
                </section>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  );
}

function LogView() {
  const server = createMemo(() => devServers().find((s) => s.id === selectedServerId()));
  const [query, setQuery] = createSignal("");
  const [follow, setFollow] = createSignal(true);
  let box: HTMLDivElement | undefined;
  const lines = createMemo(() => searchLines(logOf(selectedServerId()), query()));
  const shown = createMemo(() => (query() ? lines().slice(-3000) : lines().slice(-RENDER_CAP)));
  const stick = () => follow() && queueMicrotask(() => box && void (box.scrollTop = box.scrollHeight));
  createEffect(on(shown, stick));
  createEffect(on(selectedServerId, () => (setQuery(""), setFollow(true), stick())));
  const onScroll = () => box && setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 24);
  return (
    <div class="run-log">
      <Show
        when={server()}
        fallback={<EmptyState size="sm" icon={Play} title={t("run.noServer")} description={t("run.noServerDesc")} />}
      >
        {(s) => (
          <>
            <div class="run-log__bar">
              <StatusDot tone={statusTone(s())} pulse={s().status === "starting" || s().status === "stopping"} />
              <span class="run-log__title ui-truncate" title={s().runner}>{s().runner}</span>
              <span class="run-log__status">{!isLive(s()) && s().exitCode ? t("run.statusExit", { status: statusLabel(s().status), code: s().exitCode }) : statusLabel(s().status)}</span>
              <Show when={s().url}>
                {(url) => (
                  <Tooltip label={t("run.openInBrowser")}>
                    <button type="button" class="run-chip run-chip--link" onClick={() => openServer(s().id)}>
                      {url().replace("http://", "")}<Icon icon={ExternalLink} size={12} />
                    </button>
                  </Tooltip>
                )}
              </Show>
              <Show when={isLive(s()) && s().rssMb != null}>
                <span class="run-log__rss ui-tnum" title={t("run.procsTip", { count: s().procs })}>{t("run.rssProcs", { rss: formatRss(s().rssMb), count: s().procs })}</span>
              </Show>
              <span class="run-log__spacer" />
              <Input
                size="sm"
                wrapperClass="run-log__search"
                placeholder={t("run.searchLog")}
                aria-label={t("run.searchLogAria")}
                leading={<Icon icon={Search} size={12} />}
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                trailing={query() ? <span class="ui-tnum run-log__count">{lines().length}</span> : undefined}
              />
              <IconButton icon={Trash2} label={t("run.clearLog")} size="sm" onClick={() => clearLog(s().id)} />
              <Show when={isLive(s())} fallback={<IconButton icon={X} label={t("run.forget")} size="sm" onClick={() => dismissServer(s().id)} />}>
                <IconButton icon={RotateCw} label={t("run.restart")} size="sm" disabled={s().status === "stopping"} onClick={() => restartServer(s().id)} />
              </Show>
            </div>
            <div class="run-log__body" ref={(el: HTMLDivElement) => (box = el)} onScroll={onScroll} role="log" aria-label={t("run.output")} tabIndex={0}>
              <Show when={lines().length > shown().length}><div class="run-note">{t("run.showingLast", { shown: shown().length, total: lines().length })}</div></Show>
              <For each={shown()}>
                {(l) => (
                  <div class="run-line">
                    <For each={highlight(parseAnsi(l.text), query())}>
                      {(seg) => (
                        <span
                          class="run-seg"
                          classList={{ "run-seg--bold": seg.bold, "run-seg--dim": seg.dim, "run-seg--italic": seg.italic, "run-seg--underline": seg.underline, "run-seg--hit": seg.hit }}
                          style={{ color: seg.fg, "background-color": seg.hit ? undefined : seg.bg }}
                        >
                          {seg.text}
                        </span>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <Show when={!follow()}>
              <button type="button" class="run-log__follow" onClick={() => (setFollow(true), stick())}>{t("run.jumpToEnd")}</button>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function Banners() {
  const heavy = () => heavyServers();
  return (
    <>
      <Show when={processAccess() && !processAccess()!.startable}>
        <div class="run-banner" data-tone="warn" role="status">
          <Icon icon={ShieldAlert} size={14} />
          <span>{processAccess()?.jail === "e2e" ? t("run.banner.e2e") : t("run.banner.readOnly")}</span>
          <Show when={processAccess()?.jail === "readOnly"}>
            <Button size="sm" variant="secondary" onClick={() => openSettings("safety")}>{t("run.banner.allow")}</Button>
          </Show>
        </div>
      </Show>
      <Show when={heavy().length > 0}>
        <div class="run-banner" data-tone="info" role="status">
          <Icon icon={ShieldAlert} size={14} />
          <span>{t("run.banner.heavy", { runner: heavy()[0].runner, rss: formatRss(heavy()[0].rssMb) })}</span>
        </div>
      </Show>
    </>
  );
}

function PendingDialog() {
  const p = () => pendingStart();
  return (
    <Dialog
      open={!!p()}
      onClose={cancelPending}
      size="sm"
      role="alertdialog"
      title={p()?.kind === "heavy" ? t("run.pending.heavyTitle") : t("run.pending.confirmTitle", { runner: p()?.script.runner ?? "" })}
      description={p()?.kind === "heavy" ? (p() as { message: string }).message : t("run.pending.confirmDesc")}
      footer={
        <>
          <Button variant="ghost" onClick={cancelPending}>{t("run.pending.cancel")}</Button>
          <Button variant={p()?.kind === "heavy" ? "secondary" : "danger"} data-autofocus onClick={confirmPending}>{p()?.kind === "heavy" ? t("run.pending.startAnyway") : t("run.pending.runAnyway")}</Button>
        </>
      }
    >
      <Show when={p()?.kind === "confirm" ? p()?.script : undefined}>
        {(s) => (
          <ul class="run-reasons">
            <For each={s().reasons}>{(r) => <li>{r}</li>}</For>
            <li>{t("run.pending.forbidden")}</li>
          </ul>
        )}
      </Show>
    </Dialog>
  );
}

/** The bottom tool window: scripts per repo on the left, the selected server's log on the right. */
export default function RunPanel() {
  const [filter, setFilter] = createSignal("");
  let filterInput: HTMLInputElement | undefined;
  onMount(() => {
    wire();
    const first = currentRepoId() ?? repoList()[0]?.id;
    if (first) selectRepo(first);
    void refreshAccess();
  });
  // The workspace may arrive after the panel.
  createEffect(() => {
    if (!currentRepoId() && repoList().length) selectRepo(repoList()[0].id);
  });
  createEffect(on(currentRepoId, () => void refreshAccess()));
  createEffect(on(filterFocusTick, (n, prev) => n !== prev && prev !== undefined && queueMicrotask(() => filterInput?.focus())));
  onCleanup(() => setFilter(""));
  const live = () => liveServers().length;
  const startFirst = () => {
    const state = currentRepoId() ? catalogState(currentRepoId()!) : undefined;
    const scripts = typeof state === "object" && "catalog" in state ? groupScripts(state.catalog.scripts, filter()).flatMap((g) => g.scripts) : [];
    if (scripts.length === 1 || (scripts.length > 0 && filter())) requestStart(currentRepoId()!, scripts[0]);
  };
  return (
    <div class="run">
      <div class="run__bar">
        <div class="run__repos" role="tablist" aria-label={t("run.repository")}>
          <For each={repoList()}>
            {(r) => (
              <button type="button" role="tab" class="run__repo" aria-selected={currentRepoId() === r.id} onClick={() => selectRepo(r.id)}>
                <RepoBadge color={r.color} badge={r.badge} size={16} />
                <span class="ui-truncate">{r.name}</span>
                <Show when={devServers().some((s) => s.repoId === r.id && isLive(s))}><StatusDot tone="ok" size={6} label={t("run.running")} /></Show>
              </button>
            )}
          </For>
        </div>
        <Input
          size="sm"
          wrapperClass="run__filter"
          placeholder={t("run.filter")}
          aria-label={t("run.filter")}
          ref={(el: HTMLInputElement) => (filterInput = el)}
          leading={<Icon icon={Search} size={12} />}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => (e.key === "Enter" ? startFirst() : e.key === "Escape" && setFilter(""))}
        />
        <Button size="sm" variant="ghost" icon={Square} disabled={live() === 0} onClick={stopAll}>{live() ? t("run.stopAllCount", { count: live() }) : t("run.stopAll")}</Button>
        <IconButton icon={X} label={t("run.hidePanel")} size="sm" onClick={() => setToolWindow("bottom", null)} />
      </div>
      <Banners />
      <div class="run__body">
        <Show when={currentRepoId()} fallback={<EmptyState size="sm" icon={Play} title={t("run.noRepo")} description={t("run.noRepoDesc")} />}>
          <ScriptList repoId={currentRepoId()!} filter={filter()} />
        </Show>
        <LogView />
      </div>
      <PendingDialog />
    </div>
  );
}
