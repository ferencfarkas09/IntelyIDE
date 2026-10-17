//! Notifications inbox ((design notes: integrations-plan) E3): DTOs and parsing of the real backend's shapes
//! (`controllers/notification.controller.js`): `GET /api/notifications?includeMetadata=true` -> `{ docs, total, ... }`,
//! `GET /api/notifications/badge` -> `{ notifications, mail, total }` (only `notifications` is this inbox: `total` adds the
//! mail), `PATCH /api/notifications/{id}/read|unread`, `PATCH /api/notifications/read-all`, `DELETE /api/notifications/{id}`,
//! and the Socket.IO event `notification:new` (one document). Unknown fields are ignored, a missing one defaults.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "specta")]
use specta_typescript::Number;

use crate::parse::{list, millis, number, text};
use crate::types::NotifyMode;

/// Longest body kept per notification; the inbox shows a short preview and bodies are never logged.
const BODY_MAX: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NotificationItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub body: Option<String>,
    /// The server's category (`mention`, `task`, `deploy`, ...) when it sends one.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub kind: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
    pub created_at_ms: Option<i64>,
    pub read: bool,
    /// Chat notifications carry where they point (`metadata`): the channel, the message and the thread root of a reply.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub channel_id: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub message_id: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub thread_root: Option<String>,
    /// `chat.message.direct|mention|channel|thread`, ...
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub event_key: Option<String>,
    /// What the settings group it under (see [`category`]): `order`, `delivery`, `invoice`, `chat`, `task`, ..., or `other`.
    #[serde(default)]
    pub category: String,
    /// The settings say Quiet for its category: shown in the inbox, not counted and not announced.
    #[serde(default)]
    pub quiet: bool,
}

/// The most categories the settings keep, so a server that sends a new type every time cannot fill `settings.json`.
pub const KINDS_MAX: usize = 64;
const KIND_LEN: usize = 64;

/// The settings key of a category: lowercase, at most 64 characters of letters, digits, `.`, `_` and `-`. Anything else is refused.
pub fn clean_kind(raw: &str) -> Option<String> {
    let kind = raw.trim().to_lowercase();
    let fine = !kind.is_empty() && kind.chars().count() <= KIND_LEN && kind.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    fine.then_some(kind)
}

/// Types that are one category whatever they are called: the start decides (`orderCreated`, `orders`, `shipping`, `billing`).
const SAME: &[(&str, &[&str])] = &[("order", &["order"]), ("delivery", &["deliver", "shipping", "shipment"]), ("invoice", &["invoice", "billing"])];

/// The category of a notification: its server `type`, else the first part of its event key (`order.created` -> `order`), else
/// `other`. A type that cannot be a settings key counts as `other`; the names for orders, delivery and invoices are folded.
pub fn category(kind: Option<&str>, event_key: Option<&str>) -> String {
    let raw = kind.filter(|k| !k.trim().is_empty()).or_else(|| event_key.and_then(|e| e.split('.').next()));
    let Some(kind) = raw.and_then(clean_kind) else { return "other".to_owned() };
    for (name, starts) in SAME {
        if starts.iter().any(|s| kind.starts_with(s)) {
            return (*name).to_owned();
        }
    }
    kind
}

/// What the person sees of `raw` under their settings. A category set to Off is left out, one set to Quiet is marked `quiet`, and
/// neither counts as unread. The server's badge is a total, so the count is lowered by the unread ones of the loaded list.
pub fn shown(raw: &NotificationsView, modes: &BTreeMap<String, NotifyMode>) -> NotificationsView {
    if modes.is_empty() {
        return raw.clone();
    }
    let mut silent = 0u32;
    let mut items = Vec::with_capacity(raw.items.len());
    for item in &raw.items {
        match modes.get(&item.category) {
            None | Some(NotifyMode::Alert) => items.push(item.clone()),
            Some(NotifyMode::Quiet) => {
                silent += u32::from(!item.read);
                items.push(NotificationItem { quiet: true, ..item.clone() });
            }
            Some(NotifyMode::Off) => silent += u32::from(!item.read),
        }
    }
    NotificationsView { items, unread: raw.unread.saturating_sub(silent), loaded: raw.loaded, stale: raw.stale }
}

/// Event `happy:notifications` carries the same shape. `loaded` is false until the list was fetched once; the badge count
/// alone is known earlier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NotificationsView {
    pub items: Vec<NotificationItem>,
    pub unread: u32,
    pub loaded: bool,
    /// Two polls in a row failed: the numbers may be out of date.
    pub stale: bool,
}

impl NotificationsView {
    pub fn empty() -> Self {
        Self { items: Vec::new(), unread: 0, loaded: false, stale: false }
    }
}

/// `GET /api/notifications/badge` -> `{ notifications, mail, total }`: the inbox's own count is `notifications`.
pub fn badge(v: &Value) -> u32 {
    let n = number(v, &["notifications"]).unwrap_or(0);
    n.clamp(0, i64::from(u32::MAX)) as u32
}

fn short(s: String) -> String {
    if s.chars().count() <= BODY_MAX {
        s
    } else {
        let mut cut: String = s.chars().take(BODY_MAX).collect();
        cut.push('…');
        cut
    }
}

/// One notification document (a list row or a `notification:new` payload).
pub fn item(n: &Value) -> Option<NotificationItem> {
    let id = text(n, &["_id", "id"])?;
    let body = text(n, &["message"]).map(short);
    let own_title = text(n, &["title"]);
    let title = own_title.clone().or_else(|| body.clone()).unwrap_or_else(|| "Notification".to_owned());
    let meta = n.get("metadata").filter(|m| m.is_object()).unwrap_or(&Value::Null);
    Some(NotificationItem {
        id,
        title: short(title),
        // Without a title the body is the title, and showing it twice would be noise.
        body: body.filter(|b| own_title.as_ref().is_some_and(|t| t != b)),
        kind: text(n, &["type"]),
        created_at_ms: millis(n, &["createdAt"]),
        read: n.get("read").and_then(Value::as_bool).unwrap_or(false),
        channel_id: text(meta, &["channelId"]),
        message_id: text(meta, &["messageId"]),
        thread_root: text(meta, &["threadRoot"]),
        event_key: text(meta, &["eventKey"]),
        category: category(text(n, &["type"]).as_deref(), text(meta, &["eventKey"]).as_deref()),
        quiet: false,
    })
}

/// `GET /api/notifications` -> `{ docs: [...] }`, newest first.
pub fn items(v: &Value) -> Vec<NotificationItem> {
    let mut out: Vec<NotificationItem> = list(v, "docs").iter().filter_map(item).collect();
    out.sort_by_key(|n| std::cmp::Reverse(n.created_at_ms.unwrap_or(0)));
    out
}

/// A pushed notification joins the list at its place (newest first); an id already there is replaced. The unread count follows.
pub fn with_new(previous: &NotificationsView, new: NotificationItem) -> NotificationsView {
    let mut items: Vec<NotificationItem> = previous.items.iter().filter(|i| i.id != new.id).cloned().collect();
    let was_unread = previous.items.iter().any(|i| i.id == new.id && !i.read);
    let adds = u32::from(!new.read && !was_unread);
    items.push(new);
    items.sort_by_key(|n| std::cmp::Reverse(n.created_at_ms.unwrap_or(i64::MAX)));
    items.truncate(100);
    NotificationsView { items, unread: previous.unread.saturating_add(adds), loaded: previous.loaded, stale: false }
}

/// Builds a view from a badge count and (optionally) the list. The shown unread count follows the badge when it is known,
/// else the list, so the bell never disagrees with what the server said last.
pub fn view(unread: Option<u32>, items: Option<Vec<NotificationItem>>, previous: &NotificationsView) -> NotificationsView {
    let loaded = previous.loaded || items.is_some();
    let items = items.unwrap_or_else(|| previous.items.clone());
    let unread = unread.unwrap_or_else(|| items.iter().filter(|i| !i.read).count() as u32);
    NotificationsView { items, unread, loaded, stale: false }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A fixture copied from the real shape (`notification.model.js`, `chatNotifications.service.js`).
    fn doc(id: &str, read: bool, at: &str) -> Value {
        json!({ "_id": id, "recipient": "u_1", "title": "Anna · general", "message": "szia", "read": read, "type": "chat", "relatedId": "m1", "relatedModel": "ChatMessage",
            "createdAt": at, "metadata": { "type": "chat", "channelId": "c1", "messageId": "m1", "threadRoot": "", "restaurantId": "r_1", "restaurant": "r_1", "actorName": "Anna", "preview": "szia", "eventKey": "chat.message.channel" } })
    }

    #[test]
    fn the_badge_is_the_inbox_count_not_the_mail_total() {
        assert_eq!(badge(&json!({ "notifications": 3, "mail": 4, "total": 7 })), 3);
        assert_eq!(badge(&json!({ "notifications": -2, "mail": 0, "total": 0 })), 0);
        assert_eq!(badge(&json!({})), 0);
        assert_eq!(badge(&json!({ "notifications": "x" })), 0);
    }

    #[test]
    fn docs_are_read_newest_first_with_the_chat_target_and_bodies_are_capped() {
        let long = "x".repeat(900);
        let mut d3 = doc("n3", false, "2026-10-03T07:00:00Z");
        d3["message"] = json!(long);
        d3["metadata"]["threadRoot"] = json!("m0");
        let rows = items(&json!({ "docs": [doc("n1", true, "2026-10-03T08:00:00Z"), doc("n2", false, "2026-10-03T09:00:00Z"), d3, { "title": "no id is dropped" }], "total": 3, "limit": 20, "page": 1, "pages": 1 }));
        assert_eq!(rows.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["n2", "n1", "n3"]);
        let n2 = &rows[0];
        assert_eq!((n2.title.as_str(), n2.body.as_deref(), n2.kind.as_deref(), n2.read), ("Anna · general", Some("szia"), Some("chat"), false));
        assert_eq!((n2.channel_id.as_deref(), n2.message_id.as_deref(), n2.thread_root.as_deref(), n2.event_key.as_deref()), (Some("c1"), Some("m1"), None, Some("chat.message.channel")));
        assert_eq!(rows[2].thread_root.as_deref(), Some("m0"));
        assert!(rows[2].body.as_deref().unwrap().chars().count() <= BODY_MAX + 1);
        assert!(rows[1].read);
        assert!(items(&json!({ "nonsense": 1 })).is_empty());
    }

    #[test]
    fn a_pushed_notification_joins_the_list_and_counts_once() {
        let first = view(Some(1), Some(items(&json!({ "docs": [doc("n1", false, "2026-10-03T08:00:00Z")] }))), &NotificationsView::empty());
        let pushed = item(&doc("n2", false, "2026-10-03T09:00:00Z")).unwrap();
        let next = with_new(&first, pushed.clone());
        assert_eq!((next.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), next.unread, next.loaded), (vec!["n2", "n1"], 2, true));
        assert_eq!(with_new(&next, pushed).unread, 2, "a replayed event does not count twice");
        assert_eq!(with_new(&next, item(&doc("n3", true, "2026-10-03T10:00:00Z")).unwrap()).unread, 2, "a read one adds nothing");
    }

    #[test]
    fn the_view_prefers_the_badge_and_remembers_the_list() {
        let first = view(Some(2), Some(items(&json!({ "docs": [{ "_id": "a", "title": "A" }, { "_id": "b", "title": "B", "read": true }] }))), &NotificationsView::empty());
        assert_eq!((first.unread, first.items.len(), first.loaded), (2, 2, true));
        let badge_only = view(Some(0), None, &first);
        assert_eq!((badge_only.unread, badge_only.items.len(), badge_only.loaded), (0, 2, true));
        let counted = view(None, Some(vec![]), &first);
        assert_eq!(counted.unread, 0);
        assert!(!view(Some(4), None, &NotificationsView::empty()).loaded);
    }

    fn row(id: &str, kind: &str, read: bool) -> NotificationItem {
        item(&json!({ "_id": id, "title": id, "type": kind, "read": read, "createdAt": "2026-10-03T08:00:00Z" })).unwrap()
    }

    #[test]
    fn a_category_is_the_type_with_the_names_for_orders_delivery_and_invoices_folded() {
        for (kind, want) in [("order", "order"), ("Orders", "order"), ("orderCreated", "order"), ("new_order", "new_order"), ("delivery", "delivery"), ("deliveryDelayed", "delivery"), ("shipping", "delivery"), ("shipment_sent", "delivery"), ("invoice", "invoice"), ("invoices", "invoice"), ("billing", "invoice"), ("chat", "chat"), ("TASK", "task")] {
            assert_eq!(category(Some(kind), None), want, "{kind}");
        }
        assert_eq!(category(None, Some("order.created")), "order", "no type: the first part of the event key");
        assert_eq!(category(Some("  "), Some("chat.message.mention")), "chat");
        assert_eq!(category(Some("invoice"), Some("order.created")), "invoice", "the type wins over the event key");
        for odd in [None, Some(""), Some("two words"), Some("ő"), Some("a/b")] {
            assert_eq!(category(odd, None), "other", "{odd:?}");
        }
        assert_eq!(category(Some(&"x".repeat(65)), None), "other", "too long to be a settings key");
    }

    #[test]
    fn a_settings_key_is_lowercase_and_plain() {
        assert_eq!(clean_kind("  Order-2.x_y "), Some("order-2.x_y".to_owned()));
        for bad in ["", "   ", "a b", "a/b", "a\u{0}b", "ő", &"x".repeat(65)] {
            assert_eq!(clean_kind(bad), None, "{bad:?}");
        }
        assert!(clean_kind(&"x".repeat(64)).is_some());
    }

    #[test]
    fn the_items_carry_their_category_and_start_out_loud() {
        let order = row("o1", "orderCreated", false);
        assert_eq!((order.category.as_str(), order.quiet), ("order", false));
        assert_eq!(item(&json!({ "_id": "x", "title": "t", "metadata": { "eventKey": "invoice.paid" } })).unwrap().category, "invoice");
        assert_eq!(item(&json!({ "_id": "x", "title": "t" })).unwrap().category, "other");
    }

    fn base() -> NotificationsView {
        let items = vec![row("o1", "order", false), row("d1", "delivery", false), row("d2", "delivery", true), row("i1", "invoice", false), row("c1", "chat", false), row("m1", "weird", false)];
        NotificationsView { items, unread: 7, loaded: true, stale: false }
    }

    #[test]
    fn without_settings_the_view_is_what_the_server_said() {
        assert_eq!(shown(&base(), &BTreeMap::new()), base());
        let alert: BTreeMap<String, NotifyMode> = [("order".to_owned(), NotifyMode::Alert)].into();
        assert_eq!(shown(&base(), &alert), base(), "an explicit alert changes nothing");
    }

    #[test]
    fn quiet_keeps_the_item_but_not_the_count_and_off_hides_it() {
        let modes: BTreeMap<String, NotifyMode> = [("order".to_owned(), NotifyMode::Quiet), ("delivery".to_owned(), NotifyMode::Off), ("unlisted".to_owned(), NotifyMode::Off)].into();
        let v = shown(&base(), &modes);
        assert_eq!(v.items.iter().map(|i| (i.id.as_str(), i.quiet)).collect::<Vec<_>>(), vec![("o1", true), ("i1", false), ("c1", false), ("m1", false)]);
        // 7 on the server; o1 (quiet, unread) and d1 (off, unread) are taken off; d2 was read and takes nothing off.
        assert_eq!((v.unread, v.loaded, v.stale), (5, true, false));
        let all_off: BTreeMap<String, NotifyMode> = ["order", "delivery", "invoice", "chat", "other", "weird"].iter().map(|k| ((*k).to_owned(), NotifyMode::Off)).collect();
        let none = shown(&base(), &all_off);
        assert!(none.items.is_empty());
        assert_eq!(none.unread, 2, "the server count is a total: the 5 unread ones of the loaded list come off, 2 are beyond it");
    }

    #[test]
    fn the_count_never_goes_below_zero() {
        let mut raw = base();
        raw.unread = 1;
        let modes: BTreeMap<String, NotifyMode> = [("order".to_owned(), NotifyMode::Off), ("delivery".to_owned(), NotifyMode::Off)].into();
        assert_eq!(shown(&raw, &modes).unread, 0);
    }
}
