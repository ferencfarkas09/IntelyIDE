//! Tauri commands of Team chat (Beta 2, lane R1), on top of `intely_happy`. The `happy:chat` event (deltas) is emitted by the
//! sink in `happy.rs`; meeting live events reach the existing `happy:meetings` event. The webview never sees the token, the
//! socket or raw Happy JSON, and sending costs store credits on the real service (the summary carries `sendCost`).

use intely_core::EngineError;
use intely_happy::types::{ChatChannel, ChatMember, ChatMessage, ChatPerson, ChatSearch, ChatSummary, MessagePage, NotifyLevel, ThreadSummary, ThreadView};
use intely_happy::ApiError;
use tauri::State;

use super::happy::HappyState;

type Res<T> = Result<T, EngineError>;

fn to_engine(e: ApiError) -> EngineError {
    EngineError::new(&e.code, e.message)
}

/// The cached channel list and counters; no network.
#[tauri::command]
pub async fn happy_chat_summary(state: State<'_, HappyState>) -> Res<ChatSummary> {
    Ok(state.hub()?.chat_summary())
}

/// Fetches the channel list now.
#[tauri::command]
pub async fn happy_chat_refresh(state: State<'_, HappyState>) -> Res<ChatSummary> {
    state.hub()?.chat_refresh().await.map_err(to_engine)
}

/// The chat tab was shown or hidden (and which channel is open): switches the polling safety net.
#[tauri::command]
pub async fn happy_chat_set_active(state: State<'_, HappyState>, open: bool, channel_id: Option<String>) -> Res<()> {
    state.hub()?.chat_set_active(open, channel_id);
    Ok(())
}

/// Opens a channel: the newest page is fetched; everything cached for it comes back (oldest first).
#[tauri::command]
pub async fn happy_chat_open(state: State<'_, HappyState>, channel_id: String) -> Res<MessagePage> {
    state.hub()?.chat_open(&channel_id).await.map_err(to_engine)
}

/// The next older page; `before` is the previous page's `cursor`.
#[tauri::command]
pub async fn happy_chat_older(state: State<'_, HappyState>, channel_id: String, before: String) -> Res<MessagePage> {
    state.hub()?.chat_older(&channel_id, &before).await.map_err(to_engine)
}

/// Sends a message (spends store credits). A retry passes the failed message's `clientMessageId`.
#[tauri::command]
pub async fn happy_chat_send(state: State<'_, HappyState>, channel_id: String, text: String, mentions: Option<Vec<String>>, client_message_id: Option<String>, thread_root_id: Option<String>) -> Res<ChatMessage> {
    state.hub()?.chat_send(&channel_id, &text, mentions.unwrap_or_default(), client_message_id, thread_root_id).await.map_err(to_engine)
}

/// The window around one message (jump to a notification, a thread root, a search hit); not cached.
#[tauri::command]
pub async fn happy_chat_around(state: State<'_, HappyState>, channel_id: String, message_id: String) -> Res<MessagePage> {
    state.hub()?.chat_around(&channel_id, &message_id).await.map_err(to_engine)
}

/// The page after a message (after a jump).
#[tauri::command]
pub async fn happy_chat_newer(state: State<'_, HappyState>, channel_id: String, after: String) -> Res<MessagePage> {
    state.hub()?.chat_newer(&channel_id, &after).await.map_err(to_engine)
}

/// A thread: the root and its replies (the server marks it read).
#[tauri::command]
pub async fn happy_chat_thread(state: State<'_, HappyState>, root_id: String) -> Res<ThreadView> {
    state.hub()?.chat_thread(&root_id).await.map_err(to_engine)
}

/// The "Threads" list; `unread_only` keeps the threads with news.
#[tauri::command]
pub async fn happy_chat_threads(state: State<'_, HappyState>, unread_only: bool) -> Res<Vec<ThreadSummary>> {
    state.hub()?.chat_threads(unread_only).await.map_err(to_engine)
}

/// Public channels the user has not joined.
#[tauri::command]
pub async fn happy_chat_browse(state: State<'_, HappyState>, query: String) -> Res<Vec<ChatChannel>> {
    state.hub()?.chat_browse(&query).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_create_channel(state: State<'_, HappyState>, name: String, description: String, private: bool, member_ids: Vec<String>) -> Res<ChatChannel> {
    state.hub()?.chat_create_channel(&name, &description, private, &member_ids).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_join(state: State<'_, HappyState>, channel_id: String) -> Res<ChatChannel> {
    state.hub()?.chat_join(&channel_id).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_leave(state: State<'_, HappyState>, channel_id: String) -> Res<()> {
    state.hub()?.chat_leave(&channel_id).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_update_channel(state: State<'_, HappyState>, channel_id: String, name: Option<String>, description: Option<String>, topic: Option<String>) -> Res<ChatChannel> {
    state.hub()?.chat_update_channel(&channel_id, name, description, topic).await.map_err(to_engine)
}

/// The member's own preferences: `notify_level`, mute until a time (`muted_until_ms`; 0 or less unmutes) and the star.
#[tauri::command]
pub async fn happy_chat_preferences(state: State<'_, HappyState>, channel_id: String, notify_level: Option<NotifyLevel>, muted_until_ms: Option<i64>, starred: Option<bool>) -> Res<ChatChannel> {
    let muted = muted_until_ms.map(|ms| (ms > 0).then_some(ms));
    state.hub()?.chat_preferences(&channel_id, notify_level, muted, starred).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_members(state: State<'_, HappyState>, channel_id: String) -> Res<Vec<ChatMember>> {
    state.hub()?.chat_members(&channel_id).await.map_err(to_engine)
}

/// Invites people into a channel (the server refuses direct/group channels; private ones need a channel admin).
#[tauri::command]
pub async fn happy_chat_add_members(state: State<'_, HappyState>, channel_id: String, user_ids: Vec<String>) -> Res<Vec<ChatMember>> {
    state.hub()?.chat_add_members(&channel_id, &user_ids).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_remove_member(state: State<'_, HappyState>, channel_id: String, user_id: String) -> Res<()> {
    state.hub()?.chat_remove_member(&channel_id, &user_id).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_edit(state: State<'_, HappyState>, message_id: String, text: String) -> Res<ChatMessage> {
    state.hub()?.chat_edit(&message_id, &text).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_delete(state: State<'_, HappyState>, channel_id: String, message_id: String, thread_root_id: Option<String>) -> Res<()> {
    state.hub()?.chat_delete(&channel_id, &message_id, thread_root_id).await.map_err(to_engine)
}

/// Toggles the user's reaction on a message.
#[tauri::command]
pub async fn happy_chat_react(state: State<'_, HappyState>, message_id: String, emoji: String) -> Res<ChatMessage> {
    state.hub()?.chat_react(&message_id, &emoji).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_pin(state: State<'_, HappyState>, message_id: String, pinned: bool) -> Res<ChatMessage> {
    state.hub()?.chat_pin(&message_id, pinned).await.map_err(to_engine)
}

/// Server-side search over messages, channels and people.
#[tauri::command]
pub async fn happy_chat_search(state: State<'_, HappyState>, query: String, channel_id: Option<String>) -> Res<ChatSearch> {
    state.hub()?.chat_search(&query, channel_id).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_mark_read(state: State<'_, HappyState>, channel_id: String) -> Res<ChatSummary> {
    state.hub()?.chat_mark_read(&channel_id).await.map_err(to_engine)
}

/// People for the mention picker, the new-direct-message search and the invite dialog (cached for 5 minutes).
#[tauri::command]
pub async fn happy_chat_directory(state: State<'_, HappyState>, query: String) -> Res<Vec<ChatPerson>> {
    state.hub()?.chat_directory(&query).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_chat_open_direct(state: State<'_, HappyState>, user_ids: Vec<String>) -> Res<ChatChannel> {
    state.hub()?.chat_open_direct(&user_ids).await.map_err(to_engine)
}

/// "The user is typing" hint over the live socket (throttled to one per 3 s); false when it was not sent.
#[tauri::command]
pub async fn happy_chat_typing(state: State<'_, HappyState>, channel_id: String) -> Res<bool> {
    Ok(state.hub()?.chat_typing(&channel_id))
}
