//! Hub side of the Notifications inbox (plan E3): the focused poll (badge every 45 s, the list only when the count moved),
//! the cached view the webview reads, the mark-read / unread / delete verbs and the pushed `notification:new` event.
//! Notification text is never logged.

use serde_json::{json, Value};

use super::{ApiError, Hub, Id, Method, Scope};
use crate::notifications::{self, NotificationsView};

/// The list is asked for this many rows; the inbox is a glance, not an archive.
const PAGE: &str = "30";

pub(super) struct InboxState {
    view: NotificationsView,
    misses: u32,
}

impl Default for InboxState {
    fn default() -> Self {
        Self { view: NotificationsView::empty(), misses: 0 }
    }
}

impl Hub {
    /// The last known inbox (kept fresh by polling while the window is focused). Makes no request.
    pub fn notifications_current(&self) -> NotificationsView {
        self.st().nt.view.clone()
    }

    fn set_inbox(&self, view: NotificationsView) -> NotificationsView {
        let changed = {
            let mut st = self.st();
            st.nt.misses = 0;
            let changed = st.nt.view != view;
            st.nt.view = view.clone();
            changed
        };
        if changed {
            self.0.sink.notifications(&view);
        }
        view
    }

    /// Two failed polls in a row mark what is shown as out of date.
    pub(super) fn inbox_missed(&self) {
        let view = {
            let mut st = self.st();
            st.nt.misses += 1;
            if st.nt.misses < 2 || st.nt.view.stale || !st.nt.view.loaded {
                return;
            }
            st.nt.view.stale = true;
            st.nt.view.clone()
        };
        self.0.sink.notifications(&view);
    }

    async fn fetch_badge(&self) -> Result<u32, ApiError> {
        Ok(notifications::badge(&self.request(Scope::Notifications, Method::Get, "/api/notifications/badge", &[], None).await?))
    }

    async fn fetch_inbox_items(&self) -> Result<Vec<notifications::NotificationItem>, ApiError> {
        Ok(notifications::items(&self.request(Scope::Notifications, Method::Get, "/api/notifications", &[("limit", PAGE), ("includeMetadata", "true")], None).await?))
    }

    /// One poll: the badge always, the list only on the first poll and when the count changed.
    #[doc(hidden)]
    pub async fn poll_inbox(&self) -> Result<(), ApiError> {
        let unread = self.fetch_badge().await?;
        let previous = self.notifications_current();
        let items = if !previous.loaded || previous.unread != unread { Some(self.fetch_inbox_items().await?) } else { None };
        self.set_inbox(notifications::view(Some(unread), items, &previous));
        Ok(())
    }

    /// Fetches the badge and the list now (the inbox panel opened, or the user pressed refresh).
    pub async fn notifications_list(&self) -> Result<NotificationsView, ApiError> {
        self.require(Id::Notifications)?;
        let unread = self.fetch_badge().await?;
        let items = self.fetch_inbox_items().await?;
        let previous = self.notifications_current();
        Ok(self.set_inbox(notifications::view(Some(unread), Some(items), &previous)))
    }

    /// The socket pushed a new notification: it joins the inbox and the badge at once (no poll), and the view event tells the
    /// toast watcher. A repeated id (a replay after a reconnect) is not counted twice.
    pub(crate) fn on_notification_new(&self, data: &Value) {
        let Some(item) = notifications::item(data) else { return };
        let previous = self.notifications_current();
        let view = notifications::with_new(&previous, item);
        self.set_inbox(view);
    }

    /// Marks one notification read (`PATCH /api/notifications/{id}/read`); it needs "Allow actions".
    pub async fn notifications_mark_read(&self, id: &str) -> Result<NotificationsView, ApiError> {
        self.require(Id::Notifications)?;
        let path = format!("/api/notifications/{id}/read");
        self.request(Scope::Notifications, Method::Patch, &path, &[], Some(&json!({}))).await?;
        let mut view = self.notifications_current();
        if let Some(item) = view.items.iter_mut().find(|i| i.id == id && !i.read) {
            item.read = true;
            view.unread = view.unread.saturating_sub(1);
        }
        Ok(self.set_inbox(view))
    }

    /// Puts a notification back to unread (`PATCH /api/notifications/{id}/unread`).
    pub async fn notifications_mark_unread(&self, id: &str) -> Result<NotificationsView, ApiError> {
        self.require(Id::Notifications)?;
        let path = format!("/api/notifications/{id}/unread");
        self.request(Scope::Notifications, Method::Patch, &path, &[], Some(&json!({}))).await?;
        let mut view = self.notifications_current();
        if let Some(item) = view.items.iter_mut().find(|i| i.id == id && i.read) {
            item.read = false;
            view.unread = view.unread.saturating_add(1);
        }
        Ok(self.set_inbox(view))
    }

    pub async fn notifications_mark_all_read(&self) -> Result<NotificationsView, ApiError> {
        self.require(Id::Notifications)?;
        self.request(Scope::Notifications, Method::Patch, "/api/notifications/read-all", &[], Some(&json!({}))).await?;
        let mut view = self.notifications_current();
        view.items.iter_mut().for_each(|i| i.read = true);
        view.unread = 0;
        Ok(self.set_inbox(view))
    }

    /// Removes one notification (`DELETE /api/notifications/{id}`).
    pub async fn notifications_delete(&self, id: &str) -> Result<NotificationsView, ApiError> {
        self.require(Id::Notifications)?;
        let path = format!("/api/notifications/{id}");
        self.request(Scope::Notifications, Method::Delete, &path, &[], None).await?;
        let mut view = self.notifications_current();
        if let Some(i) = view.items.iter().position(|i| i.id == id) {
            if !view.items.remove(i).read {
                view.unread = view.unread.saturating_sub(1);
            }
        }
        Ok(self.set_inbox(view))
    }
}
