import { createSignal, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { Badge, ChevronDown, ChevronRight, MessagesSquare } from "../../ui-kit";
import { ChatPanel } from "./ChatPanel";
import { loadThread, unreadOf, watchChat } from "./chat";
import { loadTeam, view } from "./store";
import "./team.css";

/**
 * The owner's own run view: a collapsible "Team chat" strip below the transcript. Shown only when the person is in a team and this run is
 * shared (its project is on and the run is not opted out). Collapsed by default, with the count of messages not read yet.
 */
export function TeamChatStrip(props: { runId: string }) {
  const [shared, setShared] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  onMount(() => {
    watchChat();
    void loadTeam();
    ipc.team.runShareState(props.runId).then((s) => {
      setShared(s.available && s.shared);
      if (s.available && s.shared) void loadThread(null, props.runId);
    }).catch(() => undefined);
  });
  const unread = () => unreadOf(null, props.runId);
  return (
    <Show when={view().state === "member" && shared()}>
      <div class="team-chatstrip" data-testid="team-chatstrip">
        <button type="button" class="team-chatstrip__toggle" aria-expanded={open()} aria-controls={`team-chat-${props.runId}`} onClick={() => setOpen((v) => !v)}>
          {open() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <MessagesSquare size={14} />
          <span class="team-chatstrip__title">{t("team.chat.title")}</span>
          <Show when={unread() > 0}>
            <Badge tone="accent" numeric size="sm" title={t("team.chat.unread", { n: unread() })}>{unread()}</Badge>
          </Show>
        </button>
        <Show when={open()}>
          <div id={`team-chat-${props.runId}`} class="team-chatstrip__body">
            <ChatPanel ownerId={null} runId={props.runId} ownerOnline />
          </div>
        </Show>
      </div>
    </Show>
  );
}
