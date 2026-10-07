// Notifications for the mock Happy server, in the REAL wire shapes of the Happy backend (controllers/notification.controller.js,
// models/notification.model.js): raw JSON, no {success,data} envelope, errors {code,message}.
//   GET    /api/notifications?page&limit&read&skipCount&includeMetadata -> {docs,total,limit,page,pages} (skipCount: {docs,page,limit,hasMore})
//                                                                          `metadata` only with includeMetadata=true
//   GET    /api/notifications/badge                                      -> {notifications, mail, total}  (mail is a separate count)
//   PATCH  /api/notifications/{id}/read | /unread                        -> the updated doc
//   PATCH  /api/notifications/read-all                                   -> {matchedCount, modifiedCount}
//   DELETE /api/notifications/{id}                                       -> {message}
//
// Test controls (no auth): POST /__mock/notify {title, body?, kind?, metadata?}  adds a new unread notification (a "transition").
//   POST /__mock/notify-mail {count}   sets the unread mail count the badge reports.
// Chat creates notifications through `add(...)` (see chat.mjs `/__mock/chat/say` with `notify`).

const MIN = 60_000;
const hex = (n) => `5f3${n.toString(16).padStart(21, "0")}`;
const RECIPIENT = "5f0000000000000000000001";

const seed = (t) => {
  const mk = (n, minAgo, over) => {
    const at = new Date(t - minAgo * MIN).toISOString();
    return { _id: hex(n), recipient: RECIPIENT, title: "", message: "", read: false, type: "system", relatedId: null, relatedModel: null, metadata: {}, createdAt: at, updatedAt: at, ...over };
  };
  return [
    mk(1, 10, {
      title: "Kovács Anna · #general",
      message: "@Teszt Elek can you look at the receipt rounding before the review?",
      type: "chat",
      relatedId: "5f2000000000000000000099",
      relatedModel: "ChatMessage",
      metadata: { type: "chat", channelId: "5f1000000000000000000001", messageId: "5f2000000000000000000099", threadRoot: "", restaurantId: "5f9000000000000000000001", actorName: "Kovács Anna", preview: "@Teszt Elek can you look at the receipt rounding before the review?", eventKey: "chat.message.mention" },
    }),
    mk(2, 45, { title: "Task assigned: Receipts", message: "HP-142 was assigned to you by Péter", type: "task", metadata: { taskId: "5f4000000000000000000001" } }),
    mk(3, 180, { title: "Deploy finished: sandbox", message: "Build 412 is live on sandbox", type: "system", read: true }),
    mk(4, 200, {
      title: "Kovács Anna",
      message: "kész a hotfix",
      type: "chat",
      read: true,
      relatedId: "5f2000000000000000000098",
      relatedModel: "ChatMessage",
      metadata: { type: "chat", channelId: "5f1000000000000000000004", messageId: "5f2000000000000000000098", threadRoot: "", restaurantId: "5f9000000000000000000001", actorName: "Kovács Anna", preview: "kész a hotfix", eventKey: "chat.message.direct" },
    }),
  ];
};

export function createNotifications({ now = () => Date.now() } = {}) {
  let items = seed(now());
  let next = 100;
  let mail = 0;

  const unread = () => items.filter((n) => !n.read).length;
  const sorted = () => [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a._id < b._id ? 1 : -1));
  const view = (n, withMeta) => {
    const { metadata, ...rest } = n;
    return withMeta ? { ...rest, metadata } : rest;
  };
  const touch = (n) => (n.updatedAt = new Date(now()).toISOString());

  const add = (doc) => {
    const at = new Date(now()).toISOString();
    const n = { _id: hex(next++), recipient: RECIPIENT, title: "", message: "", read: false, type: "system", relatedId: null, relatedModel: null, metadata: {}, createdAt: at, updatedAt: at, ...doc };
    items.push(n);
    return n;
  };

  return {
    add,
    reset() {
      items = seed(now());
      next = 100;
      mail = 0;
    },
    controls: ["/__mock/notify", "/__mock/notify-mail"],
    control(path, body) {
      if (path === "/__mock/notify-mail") {
        mail = Math.max(0, Number(body.count) || 0);
        return { ok: true, mail };
      }
      if (path !== "/__mock/notify") return undefined;
      const n = add({ title: body.title ?? "New notification", message: body.body ?? "", type: body.kind ?? "system", metadata: body.metadata ?? {} });
      return { ok: true, id: n._id, unread: unread() };
    },
    /** `{status, body}` for a notifications route, or undefined when the route is not ours. */
    handle(method, path, url, body = {}) {
      void body;
      if (method === "GET" && path === "/api/notifications/badge") {
        const notifications = unread();
        return { status: 200, body: { notifications, mail, total: notifications + mail } };
      }
      if (method === "GET" && path === "/api/notifications") {
        const q = url.searchParams;
        const page = Math.max(parseInt(q.get("page") || "1", 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(q.get("limit") || "20", 10) || 20, 1), 100);
        const readQ = q.get("read");
        let list = sorted();
        if (readQ !== null) list = list.filter((n) => n.read === (readQ === "true"));
        const withMeta = q.get("includeMetadata") === "true";
        const slice = list.slice((page - 1) * limit, (page - 1) * limit + limit + 1);
        if (q.get("skipCount") === "true") {
          const hasMore = slice.length > limit;
          return { status: 200, body: { docs: slice.slice(0, limit).map((n) => view(n, withMeta)), page, limit, hasMore } };
        }
        return { status: 200, body: { docs: slice.slice(0, limit).map((n) => view(n, withMeta)), total: list.length, limit, page, pages: Math.ceil(list.length / limit) || 1 } };
      }
      if (method === "PATCH" && path === "/api/notifications/read-all") {
        const todo = items.filter((i) => !i.read);
        todo.forEach((i) => ((i.read = true), touch(i)));
        return { status: 200, body: { matchedCount: todo.length, modifiedCount: todo.length } };
      }
      const one = /^\/api\/notifications\/([A-Za-z0-9_-]+?)(?:\/(read|unread))?$/.exec(path);
      if (!one) return undefined;
      const item = items.find((i) => i._id === one[1]);
      if (method === "PATCH" && one[2]) {
        if (!item) return { status: 404, body: { code: "NOT_FOUND", message: "Not found" } };
        item.read = one[2] === "read";
        touch(item);
        return { status: 200, body: view(item, true) };
      }
      if (method === "DELETE" && !one[2]) {
        if (!item) return { status: 404, body: { code: "NOT_FOUND", message: "Not found" } };
        items = items.filter((i) => i !== item);
        return { status: 200, body: { message: "Notification deleted successfully" } };
      }
      return undefined;
    },
  };
}
