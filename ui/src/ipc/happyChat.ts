// Team chat IPC ((design notes: integrations-plan) 2.2). The DTOs are generated from crates/happy/src/types.rs (`pnpm bindings`);
// the Tauri commands are src-tauri/src/modules/happy_chat.rs; nothing else in the UI knows their names.
import type { ChatChannel, ChatEvent, ChatMember, ChatMessage, ChatPerson, ChatSearch, ChatSummary, MessagePage, NotifyLevel, ThreadSummary, ThreadView } from "../bindings/happy";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type {
  ChatAttachment,
  ChatChannel,
  ChatEvent,
  ChatKind,
  ChatLink,
  ChatMember,
  ChatMessage,
  ChatPerson,
  ChatReaction,
  ChatSearch,
  ChatSummary,
  MessageChange,
  MessagePage,
  NotifyLevel,
  SearchHit,
  SendState,
  ThreadSummary,
  ThreadView,
} from "../bindings/happy";

/**
 * Reserved for modules that add to a message (attachments): the composer collects these from the registered extensions
 * (`platform/chatComposer.ts`) and passes them as the fourth argument of `send`. Nothing sets them yet.
 */
export type ChatSendExtras = { attachmentIds?: string[] };

/** What a send can carry besides the text: a thread to reply in and the people mentioned (user ids). */
export interface ChatSendOptions extends ChatSendExtras {
  /** Reply in the thread of this root message (never shows inline in the channel). */
  threadRootId?: string;
  /** User ids of the people @mentioned in the text (the server also parses `@channel`, `@here`, `@all`). */
  mentions?: string[];
}

/** The member's own per-channel preferences; every field is optional, only the given ones change. */
export interface ChatPreferences {
  notifyLevel?: NotifyLevel;
  /** Mute until this time (epoch ms); `0` unmutes. */
  mutedUntilMs?: number;
  starred?: boolean;
}

/**
 * Team chat. Rejections are `EngineError`s carrying the server's code: `INSUFFICIENT_CREDITS` (402), `TEAM_CHAT_NOT_ENABLED`
 * (403, the store is not in the pilot), `CREATE_FORBIDDEN`, `CHANNEL_NAME_TAKEN`, `NAME_REQUIRED`, `MANAGE_FORBIDDEN` (private
 * channel invites need a channel admin), `DIRECT_IMMUTABLE` (nobody can be invited into a direct/group conversation),
 * `USERS_REQUIRED`, `signedOut`, `notConnected`, `blocked`, ...
 */
export interface HappyChatIpc {
  /** The cached summary (no network); `refresh` fetches the channel list first. */
  summary(refresh?: boolean): Promise<ChatSummary>;
  /** The newest page of a channel (everything Rust has cached for it, oldest first); also makes it the polled channel. */
  open(channelId: string): Promise<MessagePage>;
  /**
   * Reports what the user is looking at: whether the chat tab is on screen and which conversation is open in it. Rust polls
   * the open channel only while it is, and sends no toast request (`notify`) for it.
   */
  setActive(open: boolean, channelId: string | null): Promise<void>;
  /** The page before `cursor` (the previous page's `cursor`). */
  older(channelId: string, cursor: string): Promise<MessagePage>;
  /** A window of history around one message (jump to a notification, a thread root, a search hit): `hasMore` and `hasNewer` say what is beyond. Not cached. */
  around(channelId: string, messageId: string): Promise<MessagePage>;
  /** The page after a message (after a jump, scrolling towards the present). Not cached. */
  newer(channelId: string, afterMessageId: string): Promise<MessagePage>;
  /**
   * Sends a message (spends store credits), or a thread reply with `threadRootId`. Rust adds the optimistic copy, announces it
   * as an event, and replaces it with the server's copy; sending again with the same `clientMessageId` is the retry and never
   * duplicates. A reply has `threadRoot` set and never belongs to the channel's list.
   */
  send(channelId: string, text: string, clientMessageId: string, options?: ChatSendOptions): Promise<ChatMessage>;
  markRead(channelId: string): Promise<void>;
  /** Tells the others the user is typing; Rust throttles to one per 3 s and only sends over a live socket. */
  typing(channelId: string): Promise<void>;
  /** The directory (cached 5 min in Rust), filtered by name. */
  people(query?: string): Promise<ChatPerson[]>;
  /** Finds or creates the direct channel with a person, or a group conversation with 2 to 7 people. */
  direct(personIds: string | string[]): Promise<ChatChannel>;

  // ---- threads ----
  /** The root and the replies of a thread (the server marks it read, so the thread-unread count drops). */
  thread(rootId: string): Promise<ThreadView>;
  /** The "Threads" list (threads the user takes part in); `unreadOnly` keeps those with news. */
  threads(unreadOnly?: boolean): Promise<ThreadSummary[]>;

  // ---- channels ----
  /** Public channels the user has not joined. */
  browse(query?: string): Promise<ChatChannel[]>;
  createChannel(input: { name: string; description?: string; private?: boolean; memberIds?: string[] }): Promise<ChatChannel>;
  join(channelId: string): Promise<ChatChannel>;
  leave(channelId: string): Promise<void>;
  /** Name, description, topic (the server decides who may). */
  updateChannel(channelId: string, patch: { name?: string; description?: string; topic?: string }): Promise<ChatChannel>;
  setPreferences(channelId: string, prefs: ChatPreferences): Promise<ChatChannel>;

  // ---- members (invite) ----
  members(channelId: string): Promise<ChatMember[]>;
  /** Invites people (returns the ones added). Refused for direct/group channels; a private channel needs a channel admin. */
  addMembers(channelId: string, userIds: string[]): Promise<ChatMember[]>;
  removeMember(channelId: string, userId: string): Promise<void>;

  // ---- messages ----
  edit(messageId: string, text: string): Promise<ChatMessage>;
  /** `threadRootId` says where the message lives when it is a thread reply. */
  remove(channelId: string, messageId: string, threadRootId?: string): Promise<void>;
  /** Toggles the user's reaction (an emoji) on a message. */
  react(messageId: string, emoji: string): Promise<ChatMessage>;
  pin(messageId: string, pinned: boolean): Promise<ChatMessage>;
  /** Server-side search over messages, channels and people (needs 2+ characters); `channelId` limits it to one channel. */
  search(query: string, channelId?: string): Promise<ChatSearch>;

  onEvent(cb: (e: ChatEvent) => void): Unsubscribe;
}

export function createTauriChat(): HappyChatIpc {
  const done = () => undefined;
  return {
    summary: (refresh) => call(refresh ? "happy_chat_refresh" : "happy_chat_summary"),
    open: (channelId) => call("happy_chat_open", { channelId }),
    setActive: (open, channelId) => call<void>("happy_chat_set_active", { open, channelId }),
    older: (channelId, cursor) => call("happy_chat_older", { channelId, before: cursor }),
    around: (channelId, messageId) => call("happy_chat_around", { channelId, messageId }),
    newer: (channelId, afterMessageId) => call("happy_chat_newer", { channelId, after: afterMessageId }),
    send: (channelId, text, clientMessageId, options) => call("happy_chat_send", { channelId, text, clientMessageId, mentions: options?.mentions, threadRootId: options?.threadRootId }),
    markRead: (channelId) => call("happy_chat_mark_read", { channelId }).then(done),
    typing: (channelId) => call("happy_chat_typing", { channelId }).then(done),
    people: (query) => call("happy_chat_directory", { query: query ?? "" }),
    direct: (personIds) => call("happy_chat_open_direct", { userIds: Array.isArray(personIds) ? personIds : [personIds] }),
    thread: (rootId) => call("happy_chat_thread", { rootId }),
    threads: (unreadOnly) => call("happy_chat_threads", { unreadOnly: unreadOnly ?? false }),
    browse: (query) => call("happy_chat_browse", { query: query ?? "" }),
    createChannel: (i) => call("happy_chat_create_channel", { name: i.name, description: i.description ?? "", private: i.private ?? false, memberIds: i.memberIds ?? [] }),
    join: (channelId) => call("happy_chat_join", { channelId }),
    leave: (channelId) => call("happy_chat_leave", { channelId }).then(done),
    updateChannel: (channelId, patch) => call("happy_chat_update_channel", { channelId, ...patch }),
    setPreferences: (channelId, p) => call("happy_chat_preferences", { channelId, notifyLevel: p.notifyLevel, mutedUntilMs: p.mutedUntilMs, starred: p.starred }),
    members: (channelId) => call("happy_chat_members", { channelId }),
    addMembers: (channelId, userIds) => call("happy_chat_add_members", { channelId, userIds }),
    removeMember: (channelId, userId) => call("happy_chat_remove_member", { channelId, userId }).then(done),
    edit: (messageId, text) => call("happy_chat_edit", { messageId, text }),
    remove: (channelId, messageId, threadRootId) => call("happy_chat_delete", { channelId, messageId, threadRootId }).then(done),
    react: (messageId, emoji) => call("happy_chat_react", { messageId, emoji }),
    pin: (messageId, pinned) => call("happy_chat_pin", { messageId, pinned }),
    search: (query, channelId) => call("happy_chat_search", { query, channelId }),
    onEvent: (cb) => subscribe("happy:chat", cb),
  };
}
