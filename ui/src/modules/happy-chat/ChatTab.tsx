import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { t } from "../../i18n";
import { openSettings } from "../../platform/settings";
import { AtSign, Badge, Button, EmptyState, IconButton, Lock, MessageSquare, RefreshCw, Settings, Skeleton, StatusDot, TriangleAlert } from "../../ui-kit";
import { providerState, refreshHappyStatus, happyStatus } from "../../store/happy";
import { Conversation } from "./Conversation";
import { closeMembers, membersPanelOpen } from "./dialogs";
import { ChatDialogs } from "./ChatDialogs";
import { MembersPanel } from "./MembersPanel";
import { Sidebar } from "./Sidebar";
import { ThreadPanel } from "./ThreadPanel";
import { ThreadsView } from "./ThreadsView";
import { activeChannelId, channelOf, chatLive, chatMainView, chatScreen, chatSummary, closeThread, refreshSummary, setActiveChannel, setChatMainView, setChatScreen, threadPanel } from "./state";
import "./chat.css";

/** Two columns need room for a list and a readable conversation; below this the tab shows one of them at a time. */
export const WIDE_PX = 560;
/** Three areas side by side (sidebar, conversation, thread or members panel); between WIDE_PX and this the panel is a drawer. */
export const THREE_PX = 900;

const openIntegrations = () => {
  void refreshHappyStatus();
  openSettings("integrations");
};

/** Why the chat is not running, as an empty state: off, no token, signed out (401), not permitted (403), error. */
function Gate() {
  const state = () => (happyStatus() ? providerState("chat") : undefined);
  const error = () => happyStatus()?.providers.find((p) => p.id === "chat")?.lastError;
  return (
    <div class="hc hc--gate">
      <Switch>
        <Match when={state() === "signedOut"}>
          <EmptyState
            tone="danger"
            icon={Lock}
            title={t("hc.gate.signedOut.title")}
            description={t("hc.gate.signedOut.body")}
            action={<Button variant="primary" onClick={openIntegrations}>{t("hc.openSettings")}</Button>}
          />
        </Match>
        <Match when={state() === "notPermitted" && error()?.code === "TEAM_CHAT_NOT_ENABLED"}>
          <EmptyState icon={Lock} title={t("hc.gate.notEnabled.title")} description={t("hc.gate.notEnabled.body")} />
        </Match>
        <Match when={state() === "notPermitted"}>
          <EmptyState
            icon={Lock}
            title={t("hc.gate.denied.title")}
            description={error()?.message ?? t("hc.gate.denied.body")}
            action={<Button onClick={openIntegrations}>{t("hc.openSettings")}</Button>}
          />
        </Match>
        <Match when={state() === "waitingForToken"}>
          <EmptyState icon={MessageSquare} title={t("hc.gate.token.title")} description={t("hc.gate.token.body")} action={<Button variant="primary" onClick={openIntegrations}>{t("hc.gate.token.action")}</Button>} />
        </Match>
        <Match when={state() === "probing"}>
          <div class="hc-skeleton" aria-busy="true"><Skeleton height={26} /><Skeleton height={26} /><Skeleton height={26} /></div>
        </Match>
        <Match when={state() === "error"}>
          <EmptyState tone="danger" icon={TriangleAlert} title={t("hc.gate.error.title")} description={error()?.message} action={<Button onClick={openIntegrations}>{t("hc.openSettings")}</Button>} />
        </Match>
        <Match when={true}>
          <EmptyState icon={MessageSquare} title={t("hc.gate.off.title")} description={t("hc.gate.off.body")} action={<Button onClick={openIntegrations}>{t("hc.openSettings")}</Button>} />
        </Match>
      </Switch>
    </div>
  );
}

/**
 * The panel on the right: a thread or the members. Docked beside the conversation at 900 px and more, a drawer over its right
 * side below that, a full overlay in the single-column layout. As an overlay it takes focus when it opens, gives it back to the
 * opener when it closes, and Esc closes it.
 */
function RightPanel(props: { kind: "thread" | "members"; channelId: string; rootId?: string; overlay: boolean; onClose: () => void }) {
  let el!: HTMLElement;
  onMount(() => {
    if (!props.overlay) return;
    const opener = document.activeElement as HTMLElement | null;
    queueMicrotask(() => el.focus());
    onCleanup(() => {
      if (opener && opener.isConnected) opener.focus();
    });
  });
  return (
    <aside
      class="hc-rp"
      ref={el}
      tabIndex={-1}
      data-overlay={props.overlay ? "" : undefined}
      data-kind={props.kind}
      aria-label={t("hc.panel.label")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <Show when={props.kind === "thread" && props.rootId} fallback={<MembersPanel channelId={props.channelId} onClose={props.onClose} />}>
        <ThreadPanel channelId={props.channelId} rootId={props.rootId!} onClose={props.onClose} />
      </Show>
    </aside>
  );
}

function Live() {
  let root!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    setWidth(root.clientWidth);
    const ro = new ResizeObserver(() => setWidth(root.clientWidth));
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });
  const layout = (): "three" | "two" | "one" => (width() >= THREE_PX ? "three" : width() >= WIDE_PX ? "two" : "one");
  const summary = chatSummary;
  const active = () => (activeChannelId() && (!summary()?.loaded || channelOf(activeChannelId())) ? activeChannelId() : undefined);
  const offline = () => summary()?.link === "reconnecting" || !!summary()?.stale;
  const inThreads = () => chatMainView() === "threads";

  // A remembered conversation that no longer exists (left the channel, other account) is forgotten once the list is known.
  createEffect(() => {
    if (summary()?.loaded && activeChannelId() && !channelOf(activeChannelId())) {
      setActiveChannel(undefined);
      setChatScreen("list");
    }
  });
  // The thread and the members share the right panel: opening a thread closes the members.
  createEffect(() => {
    if (threadPanel()) closeMembers();
  });
  const select = (id: string) => {
    setActiveChannel(id);
    setChatScreen("conversation");
  };
  const showThreads = () => {
    setChatMainView("threads");
    setChatScreen("conversation");
  };
  const toList = () => setChatScreen("list");
  const closePanel = () => {
    closeThread();
    closeMembers();
  };

  /** What the right panel shows, if anything. */
  const right = createMemo(
    () => {
      const th = threadPanel();
      if (th) return { kind: "thread" as const, channelId: th.channelId, rootId: th.rootId };
      const id = active();
      if (membersPanelOpen() && id && !inThreads()) return { kind: "members" as const, channelId: id, rootId: undefined };
      return undefined;
    },
    undefined,
    // Same panel = same object, so the keyed <Show> below remounts the panel (and its composer) when another thread opens.
    { equals: (a, b) => a?.kind === b?.kind && a?.channelId === b?.channelId && a?.rootId === b?.rootId },
  );
  const panel = (overlay: boolean): JSX.Element => (
    <Show when={right()} keyed>
      {(r) => <RightPanel kind={r.kind} channelId={r.channelId} rootId={r.rootId} overlay={overlay} onClose={closePanel} />}
    </Show>
  );
  const main = (onBack?: () => void): JSX.Element => (
    <Show
      when={inThreads()}
      fallback={
        <Show
          when={active()}
          keyed
          fallback={<EmptyState class="hc-cols__empty" size="sm" icon={MessageSquare} title={t("hc.pick.title")} description={t("hc.pick.body")} />}
        >
          {(id) => <Conversation channelId={id} onBack={onBack} onEscape={onBack} />}
        </Show>
      }
    >
      <ThreadsView onBack={onBack} />
    </Show>
  );
  const sidebar = () => <Sidebar activeId={active()} onSelect={select} onThreads={showThreads} />;
  const threadUnread = () => summary()?.threadUnread ?? 0;
  const badge = () => (summary()?.unreadTotal ?? 0) + threadUnread();

  return (
    <div class="hc" ref={root} data-layout={layout()} data-wide={layout() !== "one" ? "" : undefined} data-testid="chat-tab">
      <header class="hc-head">
        <h4 class="hc-head__title">{t("hc.title")}</h4>
        <Show when={badge() > 0}>
          <Badge size="sm" tone="accent" numeric title={`${t("hc.unreadTip")}${threadUnread() > 0 ? t("hc.badge.threads", { threads: threadUnread() }) : ""}`}>{badge()}</Badge>
        </Show>
        <Show when={(summary()?.mentionTotal ?? 0) > 0}>
          <span class="hc-head__mention" title={t("hc.mentioned")}><AtSign size={12} aria-label={t("hc.mentioned")} /></span>
        </Show>
        <span class="hc-head__grow" />
        <Show when={summary()?.link}>
          {(link) => (
            <span class="hc-head__link" title={link() === "live" ? t("hc.link.live") : link() === "off" ? t("hc.link.off") : t("hc.link.connecting")}>
              <StatusDot tone={link() === "live" ? "ok" : link() === "off" ? "neutral" : "warn"} size={6} label={t("hc.link.aria", { link: link() })} />
            </span>
          )}
        </Show>
        <IconButton icon={RefreshCw} label={t("hc.refresh")} size="sm" onClick={() => void refreshSummary(true)} />
        <IconButton icon={Settings} label={t("hc.settings")} tooltip={t("hc.settingsTip")} size="sm" onClick={openIntegrations} />
      </header>
      <Show when={offline() && !active()}>
        <p class="hc-stale">{t("hc.offline.list")}</p>
      </Show>
      <div class="hc-body">
        <Show
          when={layout() !== "one"}
          fallback={
            <div class="hc-single">
              <Show when={chatScreen() === "conversation" && (active() || inThreads())} fallback={sidebar()}>
                {main(toList)}
              </Show>
              {panel(true)}
            </div>
          }
        >
          <div class="hc-cols" data-docked={layout() === "three" && right() ? "" : undefined}>
            {sidebar()}
            <div class="hc-main">
              {main()}
              <Show when={layout() === "two"}>{panel(true)}</Show>
            </div>
            <Show when={layout() === "three"}>{panel(false)}</Show>
          </div>
        </Show>
      </div>
      <ChatDialogs />
    </div>
  );
}

/** The right-dock tab. */
export default function ChatTab() {
  return (
    <Show when={chatLive()} fallback={<Gate />}>
      <Live />
    </Show>
  );
}
