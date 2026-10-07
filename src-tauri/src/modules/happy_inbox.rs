//! Tauri commands of the Notifications inbox and My tasks providers (Beta 2, lane R3), on top of `intely_happy`. The events
//! `happy:notifications` and `happy:tasks` are emitted by the sink in `happy.rs`. The webview never sees raw Happy JSON.

use intely_core::EngineError;
use intely_happy::notifications::NotificationsView;
use intely_happy::tasks::TasksView;
use intely_happy::ApiError;
use tauri::State;

use super::happy::HappyState;

type Res<T> = Result<T, EngineError>;

fn to_engine(e: ApiError) -> EngineError {
    EngineError::new(&e.code, e.message)
}

#[tauri::command]
pub async fn happy_notifications_current(state: State<'_, HappyState>) -> Res<NotificationsView> {
    Ok(state.hub()?.notifications_current())
}

#[tauri::command]
pub async fn happy_notifications_list(state: State<'_, HappyState>) -> Res<NotificationsView> {
    state.hub()?.notifications_list().await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_notifications_mark_read(state: State<'_, HappyState>, id: String) -> Res<NotificationsView> {
    state.hub()?.notifications_mark_read(&id).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_notifications_mark_all_read(state: State<'_, HappyState>) -> Res<NotificationsView> {
    state.hub()?.notifications_mark_all_read().await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_notifications_mark_unread(state: State<'_, HappyState>, id: String) -> Res<NotificationsView> {
    state.hub()?.notifications_mark_unread(&id).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_notifications_delete(state: State<'_, HappyState>, id: String) -> Res<NotificationsView> {
    state.hub()?.notifications_delete(&id).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_tasks_current(state: State<'_, HappyState>) -> Res<TasksView> {
    Ok(state.hub()?.tasks_current())
}

#[tauri::command]
pub async fn happy_tasks_list(state: State<'_, HappyState>) -> Res<TasksView> {
    state.hub()?.tasks_list().await.map_err(to_engine)
}
