// Team chat for the mock Happy server, in the REAL wire shapes of the Happy backend (controllers/teamChat.controller.js,
// services/teamChat/*, chatSerializer.js): raw JSON (no {success,data} envelope), errors {code,message[,extra]}, 24-hex ids.
// REST: bootstrap, channels (list/browse/create/get/patch/join/leave/preferences/read), members (list/add/remove), messages
// (cursor paging before/after/around/threadRoot, idempotent send, threads, edit/delete/reactions/pin), thread inbox, directory,
// direct/group channels, search. Plus a real Socket.IO server (the `socket.io` npm package, a dev dependency of this folder only)
// that emits the realtime events: chat:message, chat:message:updated, chat:message:deleted, chat:channel:updated,
// chat:channel:removed, chat:read, chat:typing, notification:new (and the meeting events).
//
// Test controls (no auth, JSON body; GET works for the read-only ones). Channel/user ids accept the 24-hex id, the channel name
// ("general"), or the legacy aliases c_1 general, c_2 ops, c_3 random, d_1 the DM with Anna, g_1 the group DM; u_1 me, u_2 Anna,
// u_3 Péter, u_4 Béla, u_5 Dóra:
//   /__mock/chat/say     {channelId?, text?, from?, mention?, mentions?{users,channel}, threadRootId?, replay?, notify?}
//                        a message from someone else (replay: emit it twice; notify: also create the notification doc + notification:new)
//   /__mock/chat/typing  {channelId?, userId?}                           chat:typing from someone else
//   /__mock/chat/credits {credits}                                        a balance of 0 makes the next send a 402
//   /__mock/chat-disabled | /__mock/chat/disabled {on?}                   every /api/chat/* route answers 403 TEAM_CHAT_NOT_ENABLED
//   /__mock/chat/create-forbidden {on?}                                   POST /api/chat/channels answers 403 CREATE_FORBIDDEN
//   /__mock/chat/multi-store {on?}                                        scoped routes need restaurantId (else 400 RESTAURANT_REQUIRED)
//   /__mock/chat/drop                                                     closes every socket from the server side
//   /__mock/chat/reject  {mode: "unauthorized" | "forbidden" | null}      refuse new socket connections
//   /__mock/chat/forbid-join {on}                                         answer join:user with join:forbidden
//   /__mock/chat/meeting {action, id?, title?}                            chat:meeting (started / ended / scheduled)
//   /__mock/chat/lobby   {meetingId?, waiting}                            chat:meeting:lobby
//   /__mock/chat/script  {name: "burst" | "meeting-live" | "meeting-lobby"}  a scripted sequence of events
//   /__mock/chat/sockets                                                  {connected, connects, joined, received}

const MIN = 60_000;
const h21 = (n) => n.toString(16).padStart(21, "0");
export const userId = (n) => `5f0${h21(n)}`;
export const channelId = (n) => `5f1${h21(n)}`;
export const messageId = (n) => `5f2${h21(n)}`;
export const RESTAURANT_ID = "5f9000000000000000000001";
export const ME_ID = userId(1);

const USERS = [
  { _id: ME_ID, name: "Teszt Elek", email: "elek@example.test", role: "admin" },
  { _id: userId(2), name: "Kovács Anna", email: "anna@example.test", role: "sales" },
  { _id: userId(3), name: "Nagy Péter", email: "peter@example.test", role: "admin" },
  { _id: userId(4), name: "Szabó Béla", email: "bela@example.test", role: "support" },
  { _id: userId(5), name: "Tóth Dóra", email: "dora@example.test", role: "support" },
];
const [, ANNA, PETER, BELA] = USERS;
const ONLINE = new Set([ME_ID, ANNA._id]);
const WORDS = ["receipt", "rounding", "deploy", "sandbox", "refund", "tábla", "nyomtató", "review", "hotfix", "szia", "köszi", "kész"];
const ALIAS = { c_1: channelId(1), c_2: channelId(2), c_3: channelId(3), d_1: channelId(4), g_1: channelId(5), u_1: userId(1), u_2: userId(2), u_3: userId(3), u_4: userId(4), u_5: userId(5) };

const lite = (u) => ({ _id: u._id, name: u.name, avatar: "" });
const userById = (id) => USERS.find((u) => u._id === id);
const ISO = (t) => new Date(t).toISOString();

export function createChat({ now = () => Date.now(), token = () => "", notifications = null } = {}) {
  let channels, all, byClient, threadRead, credits, seq, rejectMode, forbidJoin, io, started, ended, disabled, createForbidden, multiStore, nextChan;
  const sockLog = { connects: 0, joined: [], received: [] };

  const member = (role, o = {}) => ({ role, joinedAt: ISO(now()), unread: 0, mentions: 0, lastReadMessageId: null, lastReadAt: null, notifyLevel: "all", mutedUntil: null, starred: false, hidden: false, ...o });
  const mkChannel = (n, type, name, memberIds, o = {}) => ({
    _id: channelId(n), type, name, description: "", topic: "", archived: false, createdBy: ME_ID, createdAt: ISO(now() - 30 * 24 * 60 * MIN),
    members: new Map(memberIds.map((id) => [id, member(o.roles?.[id] ?? "member")])), ...o.extra,
  });

  const fill = () => {
    const t = now();
    seq = 1;
    all = [];
    byClient = new Map();
    threadRead = new Map();
    credits = 12.5;
    rejectMode = null;
    forbidJoin = false;
    started = [];
    ended = new Set();
    disabled = false;
    createForbidden = false;
    multiStore = false;
    nextChan = 100;
    const everyone = USERS.map((u) => u._id);
    const general = mkChannel(1, "public", "general", everyone, { roles: { [PETER._id]: "owner" }, extra: { description: "Company-wide chatter", topic: "Sprint 42", createdBy: PETER._id } });
    const ops = mkChannel(2, "private", "ops", [ME_ID, PETER._id, BELA._id], { roles: { [PETER._id]: "owner", [ME_ID]: "admin" }, extra: { createdBy: PETER._id } });
    const random = mkChannel(3, "public", "random", [ANNA._id, PETER._id], { roles: { [ANNA._id]: "owner" }, extra: { createdBy: ANNA._id } });
    const dm = mkChannel(4, "direct", "", [ME_ID, ANNA._id]);
    const group = mkChannel(5, "group", "", [ME_ID, ANNA._id, PETER._id]);
    channels = [general, ops, random, dm, group];
    ops.members.get(ME_ID).notifyLevel = "mentions";

    const seedMsg = (c, i, count, o = {}) => {
      const from = o.from ?? (i % 3 === 0 ? userById(ME_ID) : [...c.members.keys()].filter((id) => id !== ME_ID).map(userById)[i % (c.members.size - 1)]);
      const m = {
        _id: messageId(seq++), channel: c._id, sender: from._id, kind: "text", text: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} #${i}`, systemEvent: null,
        mentions: { users: [], channel: false }, reactions: [], threadRoot: null, replyCount: 0, lastReplyAt: null, replyUsers: [], pinned: false, pinnedBy: null,
        editedAt: null, deletedAt: null, clientMessageId: null, createdAt: ISO(t - (count - i) * MIN), ...o.set,
      };
      all.push(m);
      return m;
    };
    const seedReply = (root, from, text, minAfter) => {
      const r = seedMsg(channels.find((c) => c._id === root.channel), 0, 0, { from, set: { text, threadRoot: root._id, createdAt: ISO(Date.parse(root.createdAt) + minAfter * MIN) } });
      root.replyCount += 1;
      root.lastReplyAt = r.createdAt;
      if (!root.replyUsers.includes(from._id)) root.replyUsers.push(from._id);
      return r;
    };

    // #general: 130 top-level messages + a thread (3 replies) + an edited, a deleted, reactions, a pin and a mention of me.
    const N = 130;
    const gen = [];
    for (let i = 0; i < N; i++) gen.push(seedMsg(general, i, N, i >= N - 2 ? { from: i === N - 1 ? ANNA : PETER } : {}));
    gen[10].editedAt = ISO(t - (N - 10) * MIN + 30_000);
    gen[20].deletedAt = ISO(t - (N - 20) * MIN + 60_000);
    gen[5].reactions = [{ emoji: "👍", users: [ME_ID, ANNA._id] }, { emoji: "🎉", users: [PETER._id] }];
    gen[30].pinned = true;
    gen[30].pinnedBy = PETER._id;
    gen[N - 1].mentions = { users: [ME_ID], channel: false };
    gen[N - 1].text = `<@${ME_ID}> can you look at the receipt rounding before the review?`;
    gen[N - 3].mentions = { users: [], channel: true };
    const root = gen[40];
    root.sender = ME_ID;
    root.text = "Who can take the receipt rounding bug?";
    const replies = [seedReply(root, ANNA, "I can, give me an hour", 1), seedReply(root, PETER, "Thanks Anna, please ping me when it is in review", 2), seedReply(root, userById(ME_ID), "Great, I will test it on sandbox", 3)];
    threadRead.set(`${ME_ID}:${root._id}`, replies.at(-1)._id);
    general.members.get(ME_ID).unread = 2;
    general.members.get(ME_ID).mentions = 1;
    general.members.get(ME_ID).lastReadMessageId = gen[N - 3]._id;
    general.members.get(ME_ID).lastReadAt = ISO(t - 3 * MIN);

    const opsMsgs = [];
    for (let i = 0; i < 30; i++) opsMsgs.push(seedMsg(ops, i, 30));
    opsMsgs[9].sender = ME_ID;
    seedReply(opsMsgs[9], BELA, "Seen it on the till too", 1);
    ops.members.get(ME_ID).lastReadMessageId = opsMsgs.at(-1)._id;

    for (let i = 0; i < 8; i++) seedMsg(random, i, 8);

    const dmMsgs = [];
    for (let i = 0; i < 12; i++) dmMsgs.push(seedMsg(dm, i, 12, { from: i % 2 === 0 ? userById(ME_ID) : ANNA }));
    dm.members.get(ME_ID).unread = 1;
    dm.members.get(ME_ID).lastReadMessageId = dmMsgs[10]._id;

    const grp = [];
    for (let i = 0; i < 6; i++) grp.push(seedMsg(group, i, 6));
    group.members.get(ME_ID).lastReadMessageId = grp.at(-1)._id;
  };
  fill();

  // ---- serialization (copies of chatSerializer.js) -------------------------------------------------------------------------
  const tops = (c) => all.filter((m) => m.channel === c._id && !m.threadRoot);
  const lastTop = (c) => tops(c).filter((m) => !m.deletedAt).at(-1) ?? null;
  const serializeMe = (mb) => ({
    role: mb?.role ?? null, isMember: Boolean(mb), unreadCount: mb?.unread ?? 0, mentionCount: mb?.mentions ?? 0, lastReadMessageId: mb?.lastReadMessageId ?? null,
    lastReadAt: mb?.lastReadAt ?? null, notifyLevel: mb?.notifyLevel ?? "all", mutedUntil: mb?.mutedUntil ?? null, starred: Boolean(mb?.starred), hidden: Boolean(mb?.hidden),
  });
  const serializeChannel = (c, viewer = ME_ID) => {
    const last = lastTop(c);
    const direct = c.type === "direct" || c.type === "group";
    return {
      _id: c._id, restaurant: RESTAURANT_ID, type: c.type, name: c.name || "", description: c.description || "", topic: c.topic || "", archived: Boolean(c.archived),
      createdBy: c.createdBy ?? null, createdAt: c.createdAt, lastMessageAt: last?.createdAt ?? null,
      lastMessagePreview: { text: last ? last.text.slice(0, 120) : "", senderName: last ? userById(last.sender)?.name ?? "" : "", at: last?.createdAt ?? null },
      memberCount: c.members.size, record: null, customer: null,
      directPeers: direct ? [...c.members.keys()].filter((id) => id !== viewer).map((id) => lite(userById(id))) : [],
      pinnedCount: all.filter((m) => m.channel === c._id && m.pinned && !m.deletedAt).length,
      me: serializeMe(c.members.get(viewer)),
    };
  };
  const serializeMessage = (m, extra = {}) => {
    const del = Boolean(m.deletedAt);
    const out = {
      _id: m._id, channel: m.channel, restaurant: RESTAURANT_ID,
      sender: m.sender ? { _id: m.sender, name: userById(m.sender)?.name ?? "", avatar: "", isPortal: false } : null,
      bot: null, kind: m.kind, text: del ? "" : m.text, systemEvent: m.systemEvent,
      mentions: { users: [...m.mentions.users], channel: Boolean(m.mentions.channel) },
      attachments: [],
      reactions: del ? [] : m.reactions.filter((r) => r.users.length).map((r) => ({ emoji: r.emoji, users: [...r.users], count: r.users.length })),
      recordRefs: [], meeting: null, threadRoot: m.threadRoot, replyCount: m.replyCount, lastReplyAt: m.lastReplyAt,
      replyUsers: m.replyUsers.map((id) => lite(userById(id) ?? { _id: id, name: "" })),
      pinned: Boolean(m.pinned), pinnedBy: m.pinnedBy, editedAt: m.editedAt, deletedAt: m.deletedAt, clientMessageId: m.clientMessageId, createdAt: m.createdAt,
    };
    return { ...out, ...extra };
  };
  const serializeMember = (c, id) => {
    const u = userById(id);
    const mb = c.members.get(id);
    return { _id: id, name: u.name, avatar: "", email: u.email, role: mb.role, isPortal: false, joinedAt: mb.joinedAt, online: ONLINE.has(id) };
  };
  const directoryItem = (u) => ({ _id: u._id, name: u.name, avatar: "", email: u.email, role: u.role, isPortal: false, joinedAt: ISO(now() - 90 * 24 * 60 * MIN) });

  // ---- realtime ------------------------------------------------------------------------------------------------------------
  /** The mock is one user's view; the legacy `u_1` room is the id the existing /api/user/me answers. */
  const emitUser = (id, ev, payload) => {
    if (!io) return;
    const rooms = [`user:${id}`];
    if (id === ME_ID) rooms.push("user:u_1");
    io.to(rooms).emit(ev, payload);
  };
  const emitMembers = (c, ev, payload) => [...c.members.keys()].forEach((id) => emitUser(id, ev, typeof payload === "function" ? payload(id) : payload));
  const emitChannelUpdated = (c) => emitMembers(c, "chat:channel:updated", (id) => ({ channel: serializeChannel(c, id) }));
  const emitUpdated = (m) => {
    const c = chan(m.channel);
    emitMembers(c, "chat:message:updated", { channelId: c._id, message: serializeMessage(m) });
  };

  // ---- domain --------------------------------------------------------------------------------------------------------------
  const chan = (id) => channels.find((c) => c._id === id);
  const resolveChan = (x) => {
    const id = ALIAS[x ?? "c_1"] ?? x;
    return channels.find((c) => c._id === id || c.name === id);
  };
  const resolveUser = (x) => USERS.find((u) => u._id === (ALIAS[x] ?? x));
  const msg = (id) => all.find((m) => m._id === id);
  const err = (status, code, message, extra = {}) => ({ status, body: { code, message, ...extra } });
  const ok = (body, status = 200) => ({ status, body });
  const isAdmin = (c, id = ME_ID) => ["owner", "admin"].includes(c.members.get(id)?.role);
  const isId = (s) => typeof s === "string" && /^[0-9a-f]{24}$/.test(s);
  const markThread = (uid, rootId) => {
    const last = all.filter((m) => m.threadRoot === rootId).at(-1);
    if (last) threadRead.set(`${uid}:${rootId}`, last._id);
  };

  const parseMentions = (text, given = {}) => {
    const users = new Set((Array.isArray(given.users) ? given.users : []).map(String).filter((id) => userById(id)));
    for (const [, id] of text.matchAll(/<@([0-9a-f]{24})>/g)) if (userById(id)) users.add(id);
    for (const [, id] of text.matchAll(/@\[[^\]]*\]\(([0-9a-f]{24})\)/g)) if (userById(id)) users.add(id);
    return { users: [...users], channel: Boolean(given.channel) || /(^|\s)@(channel|here|all)\b/.test(text) };
  };

  /** Stores a message and does the counter / thread bookkeeping; emits nothing. */
  const post = (c, senderId, { text, threadRoot = null, mentions, clientMessageId = null, kind = "text", systemEvent = null }) => {
    const m = {
      _id: messageId(seq++), channel: c._id, sender: senderId, kind, text, systemEvent, mentions: mentions ?? { users: [], channel: false }, reactions: [], threadRoot, replyCount: 0,
      lastReplyAt: null, replyUsers: [], pinned: false, pinnedBy: null, editedAt: null, deletedAt: null, clientMessageId, createdAt: ISO(now()),
    };
    all.push(m);
    if (clientMessageId) byClient.set(`${c._id}:${senderId}:${clientMessageId}`, m);
    if (threadRoot) {
      const root = msg(threadRoot);
      root.replyCount += 1;
      root.lastReplyAt = m.createdAt;
      if (senderId && !root.replyUsers.includes(senderId)) root.replyUsers.push(senderId);
      if (senderId) threadRead.set(`${senderId}:${threadRoot}`, m._id);
    } else if (kind !== "system") {
      for (const [id, mb] of c.members) {
        if (id === senderId) {
          mb.lastReadMessageId = m._id;
          mb.lastReadAt = m.createdAt;
          continue;
        }
        mb.unread += 1;
        if (m.mentions.channel || m.mentions.users.includes(id)) mb.mentions += 1;
      }
    }
    return m;
  };
  const broadcast = (c, m) => {
    emitMembers(c, "chat:message", { channelId: c._id, message: serializeMessage(m) });
    if (m.threadRoot) emitUpdated(msg(m.threadRoot));
  };
  const system = (c, text, systemEvent) => broadcast(c, post(c, null, { text, kind: "system", systemEvent }));

  const eventKeyFor = (c, m, viewer) => {
    if (c.type === "direct" || c.type === "group") return "chat.message.direct";
    if (m.mentions.users.includes(viewer) || m.mentions.channel) return "chat.message.mention";
    if (m.threadRoot) {
      const root = msg(m.threadRoot);
      if (root.sender === viewer || root.replyUsers.includes(viewer)) return "chat.message.thread";
    }
    return "chat.message.channel";
  };
  /** The Notification doc + notification:new the backend makes for a chat message (to me), honouring my notify level. */
  const notifyMe = (c, m) => {
    const mb = c.members.get(ME_ID);
    if (!mb || !notifications || m.sender === ME_ID) return null;
    const eventKey = eventKeyFor(c, m, ME_ID);
    const level = mb.notifyLevel;
    if (level === "none" || (level === "mentions" && !["chat.message.direct", "chat.message.mention"].includes(eventKey))) return null;
    const sender = userById(m.sender)?.name ?? "";
    const doc = notifications.add({
      title: eventKey === "chat.message.direct" ? sender : `${sender} · #${c.name}`, message: m.text.slice(0, 120), type: "chat", relatedId: m._id, relatedModel: "ChatMessage",
      metadata: { type: "chat", channelId: c._id, messageId: m._id, threadRoot: m.threadRoot ?? "", restaurantId: RESTAURANT_ID, actorName: sender, preview: m.text.slice(0, 120), eventKey },
    });
    emitUser(ME_ID, "notification:new", doc);
    return doc;
  };

  const say = (b) => {
    const c = resolveChan(b.channelId);
    if (!c) return { ok: false, error: "no such channel" };
    const from = resolveUser(b.from) ?? ANNA;
    let threadRoot = null;
    if (b.threadRootId) {
      threadRoot = msg(ALIAS[b.threadRootId] ?? b.threadRootId)?._id ?? null;
      if (!threadRoot) return { ok: false, error: "no such thread root" };
    }
    const text = b.text ?? "szia";
    const given = b.mentions ?? (b.mention ? { users: [ME_ID], channel: false } : {});
    const m = post(c, from._id, { text, threadRoot, mentions: parseMentions(text, given) });
    broadcast(c, m);
    if (b.replay) emitMembers(c, "chat:message", { channelId: c._id, message: serializeMessage(m) });
    const notification = b.notify ? notifyMe(c, m) : null;
    return { ok: true, message: serializeMessage(m), ...(b.notify ? { notification } : {}) };
  };

  const meeting = (b) => {
    const id = b.id ?? "m_live_2";
    const action = b.action ?? "started";
    const m = { id, title: b.title ?? "Ad-hoc call", channel: { id: "c_1", name: "general" }, participantCount: 2, host: { name: "Nagy Péter" }, startedAt: new Date(now()).toISOString() };
    if (action === "ended") {
      ended.add(id);
      started = started.filter((x) => x.id !== id);
    } else if (!started.some((x) => x.id === id)) {
      ended.delete(id);
      started.push(m);
    }
    emitUser(ME_ID, "chat:meeting", { action, meeting: m });
    return { ok: true, id, action };
  };

  const scripts = {
    burst: () => {
      const a = say({ channelId: "ops", text: "hotfix is out", from: "u_3", replay: true });
      emitUser(ME_ID, "chat:typing", { channelId: channelId(2), userId: PETER._id, name: PETER.name });
      return { ok: true, id: a.message._id, note: "message, replay of the same message, typing" };
    },
    "meeting-live": () => meeting({ action: "started", id: "m_live_2", title: "Hotfix call" }),
    "meeting-lobby": () => {
      meeting({ action: "started", id: "m_live_2", title: "Hotfix call" });
      emitUser(ME_ID, "chat:meeting:lobby", { meetingId: "m_live_2", waiting: 2 });
      return { ok: true };
    },
  };
  const flag = (set) => (b) => (set(Boolean(b.on ?? true)), { ok: true });
  const controls = {
    "/__mock/chat/say": say,
    "/__mock/chat/typing": (b) => {
      const u = resolveUser(b.userId ?? "u_2") ?? ANNA;
      emitUser(ME_ID, "chat:typing", { channelId: resolveChan(b.channelId)?._id ?? channelId(1), userId: u._id, name: u.name });
      return { ok: true };
    },
    "/__mock/chat/credits": (b) => ((credits = Number(b.credits ?? 0)), { ok: true, credits }),
    "/__mock/chat-disabled": flag((v) => (disabled = v)),
    "/__mock/chat/disabled": flag((v) => (disabled = v)),
    "/__mock/chat/create-forbidden": flag((v) => (createForbidden = v)),
    "/__mock/chat/multi-store": flag((v) => (multiStore = v)),
    "/__mock/chat/drop": () => (io?.disconnectSockets(true), { ok: true }),
    "/__mock/chat/reject": (b) => ((rejectMode = b.mode ?? null), { ok: true, mode: rejectMode }),
    "/__mock/chat/forbid-join": (b) => ((forbidJoin = Boolean(b.on ?? true)), { ok: true }),
    "/__mock/chat/meeting": meeting,
    "/__mock/chat/lobby": (b) => (emitUser(ME_ID, "chat:meeting:lobby", { meetingId: b.meetingId ?? "m_live_2", waiting: b.waiting ?? 1 }), { ok: true }),
    "/__mock/chat/script": (b) => scripts[b.name]?.() ?? { ok: false, error: "unknown script" },
    "/__mock/chat/sockets": () => ({ connected: io?.engine?.clientsCount ?? 0, connects: sockLog.connects, joined: sockLog.joined, received: sockLog.received }),
  };

  // ---- REST ----------------------------------------------------------------------------------------------------------------
  const needChannel = (id, { member = false } = {}) => {
    const c = chan(id);
    if (!c) return { e: err(404, "CHANNEL_NOT_FOUND", "Channel not found") };
    const mb = c.members.get(ME_ID);
    if ((member || c.type !== "public") && !mb) return { e: err(403, "NOT_A_MEMBER", "Not a member of this channel") };
    return { c, mb };
  };

  const listMessages = (c, q) => {
    const limit = Math.min(100, Math.max(1, Number(q.get("limit")) || 50));
    const threadRoot = q.get("threadRoot");
    if (threadRoot && !isId(threadRoot)) return err(400, "INVALID_THREAD_ROOT", "Invalid threadRoot");
    for (const k of ["before", "after", "around"]) if (q.get(k) && !isId(q.get(k))) return err(400, "INVALID_CURSOR", `Invalid ${k}`);
    if (threadRoot) markThread(ME_ID, threadRoot);
    const list = all.filter((m) => m.channel === c._id && (m.threadRoot ?? null) === (threadRoot || null));
    const win = (centerIdx) => {
      const olderCap = Math.floor(limit / 2);
      const start = Math.max(centerIdx - olderCap, 0);
      const end = Math.min(start + limit, list.length);
      return { items: list.slice(start, end), hasMore: start > 0, hasNewer: end < list.length };
    };
    const ser = (p, extra = {}) => ok({ ...p, items: p.items.map((m) => serializeMessage(m)), ...extra });
    const around = q.get("around");
    if (around) {
      const anchor = all.find((m) => m._id === around && m.channel === c._id);
      if (!anchor) return err(404, "MESSAGE_NOT_FOUND", "Message not found in this channel");
      if (threadRoot) {
        if (anchor._id === threadRoot) return ser({ items: list.slice(0, limit), hasMore: false, hasNewer: list.length > limit }, { anchorId: anchor._id, anchorThreadRoot: null });
        if (anchor.threadRoot !== threadRoot) return err(404, "MESSAGE_NOT_FOUND", "Message not found in this thread");
        return ser(win(list.indexOf(anchor)), { anchorId: anchor._id, anchorThreadRoot: null });
      }
      const center = anchor.threadRoot ? msg(anchor.threadRoot) : anchor;
      return ser(win(list.indexOf(center)), { anchorId: anchor._id, anchorThreadRoot: anchor.threadRoot ?? null });
    }
    if (q.get("after")) {
      const rows = list.filter((m) => m._id > q.get("after"));
      return ser({ items: rows.slice(0, limit), hasMore: rows.length > limit, hasNewer: rows.length > limit });
    }
    let hasNewer = false;
    let rows = list;
    if (q.get("before")) {
      hasNewer = list.some((m) => m._id >= q.get("before"));
      rows = list.filter((m) => m._id < q.get("before"));
    }
    return ser({ items: rows.slice(-limit), hasMore: rows.length > limit, hasNewer });
  };

  const send = (c, body) => {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const threadRootId = body.threadRootId ?? null;
    let root = null;
    if (threadRootId) {
      if (!isId(threadRootId)) return err(400, "INVALID_THREAD_ROOT", "Invalid threadRootId");
      root = all.find((m) => m._id === threadRootId && m.channel === c._id);
      if (!root) return err(404, "THREAD_ROOT_NOT_FOUND", "Thread root not found");
      if (root.threadRoot) root = msg(root.threadRoot);
    }
    const again = body.clientMessageId && byClient.get(`${c._id}:${ME_ID}:${body.clientMessageId}`);
    if (again) return ok(serializeMessage(again), 201);
    if (c.archived) return err(409, "CHANNEL_ARCHIVED", "Channel is archived");
    if (!text) return err(400, "EMPTY_MESSAGE", "Message text or attachment is required");
    if (text.length > 8000) return err(400, "MESSAGE_TOO_LONG", "Message is longer than 8000 characters");
    if (credits < 0.02) return err(402, "INSUFFICIENT_CREDITS", "Insufficient AI credits", { balance: credits });
    const m = post(c, ME_ID, { text, threadRoot: root?._id ?? null, mentions: parseMentions(text, body.mentions), clientMessageId: body.clientMessageId ?? null });
    credits = Math.max(Number((credits - 0.02).toFixed(4)), 0);
    broadcast(c, m);
    return ok(serializeMessage(m), 201);
  };

  const markRead = (c, mb, body) => {
    const topList = tops(c);
    let target = body.messageId ?? null;
    if (target && !all.some((m) => m._id === target && m.channel === c._id)) return err(404, "MESSAGE_NOT_FOUND", "Message not found in this channel");
    if (!target) target = topList.at(-1)?._id ?? null;
    mb.lastReadMessageId = target;
    mb.lastReadAt = ISO(now());
    mb.unread = topList.filter((m) => target && m._id > target && m.sender !== ME_ID && m.kind !== "system").length;
    mb.mentions = 0;
    emitMembers(c, "chat:read", { channelId: c._id, userId: ME_ID, lastReadMessageId: target });
    return ok({ channelId: c._id, lastReadMessageId: target, unreadCount: mb.unread, mentionCount: 0 });
  };

  const threadUnread = (root) => {
    const last = threadRead.get(`${ME_ID}:${root._id}`) ?? "";
    return all.filter((m) => m.threadRoot === root._id && m._id > last && m.sender !== ME_ID && !m.deletedAt).length;
  };

  const needScope = (q, body) => (multiStore && !(q.get("restaurantId") || body.restaurantId) ? err(400, "RESTAURANT_REQUIRED", "restaurantId is required for users of more than one store") : null);

  const handle = (method, path, url, body = {}) => {
    if (!path.startsWith("/api/chat/")) return undefined;
    if (disabled) return err(403, "TEAM_CHAT_NOT_ENABLED", "Team Chat is not enabled for this store yet");
    if (path.startsWith("/api/chat/meetings")) return undefined;
    const q = url.searchParams;
    const is = (m, p) => method === m && path === p;
    const mine = () => channels.filter((c) => c.members.has(ME_ID));
    if (["/api/chat/bootstrap", "/api/chat/channels", "/api/chat/direct", "/api/chat/directory", "/api/chat/threads", "/api/chat/search"].includes(path)) {
      const bad = needScope(q, body);
      if (bad) return bad;
    }

    if (is("GET", "/api/chat/bootstrap")) {
      const items = mine().map((c) => serializeChannel(c));
      const permissions = { createChannel: !createForbidden, manageChannels: true, startMeeting: true, recordMeeting: true, editSettings: true };
      return ok({
        channels: items, unreadTotal: items.reduce((n, c) => n + c.me.unreadCount, 0), mentionTotal: items.reduce((n, c) => n + c.me.mentionCount, 0),
        me: { _id: ME_ID, name: USERS[0].name, avatar: "", isPortal: false }, restaurantId: RESTAURANT_ID,
        settings: { retentionDays: 90, allowCustomerChannels: true, recordingDefault: false, whoCanCreateChannels: "everyone", emailDigest: false },
        credits: { balance: credits, messageCost: 0.02, meetingCostPerMinute: 0.4, filePerMb: 0.1 }, meetingConfigured: true, permissions,
      });
    }
    if (is("GET", "/api/chat/directory")) {
      const s = (q.get("search") ?? "").toLowerCase();
      return ok({ items: USERS.filter((u) => !s || u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s)).map(directoryItem) });
    }
    if (is("POST", "/api/chat/direct")) {
      const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String))].filter((id) => id !== ME_ID);
      if (!ids.length) return err(400, "USERS_REQUIRED", "At least one other user is required");
      if (ids.length > 7) return err(400, "TOO_MANY_MEMBERS", "A group conversation can have at most 7 people");
      if (!ids.every((id) => userById(id))) return err(403, "USERS_NOT_IN_STORE", "Every participant must be staff of this store");
      const type = ids.length === 1 ? "direct" : "group";
      const want = [ME_ID, ...ids].sort().join();
      let c = channels.find((x) => x.type === type && [...x.members.keys()].sort().join() === want);
      if (c) c.members.get(ME_ID).hidden = false;
      else {
        c = mkChannel(nextChan++, type, "", [ME_ID, ...ids]);
        channels.push(c);
      }
      emitChannelUpdated(c);
      return ok(serializeChannel(c));
    }
    if (is("GET", "/api/chat/channels")) {
      const browse = q.get("browse") === "true";
      const s = (q.get("search") ?? "").toLowerCase();
      const archived = q.get("archived") === "true";
      let list = browse ? channels.filter((c) => c.type === "public" && !c.archived && !c.members.has(ME_ID)) : mine().filter((c) => Boolean(c.archived) === archived);
      if (q.get("type")) list = list.filter((c) => c.type === q.get("type"));
      if (s) list = list.filter((c) => c.name.toLowerCase().includes(s));
      return ok({ items: list.map((c) => serializeChannel(c)) });
    }
    if (is("POST", "/api/chat/channels")) {
      if (createForbidden) return err(403, "CREATE_FORBIDDEN", "You are not allowed to create channels");
      if (!["public", "private"].includes(body.type)) return err(400, "INVALID_CHANNEL_TYPE", "type must be public, private or customer");
      const name = String(body.name ?? "").trim().replace(/^#/, "");
      if (!name) return err(400, "NAME_REQUIRED", "Channel name is required");
      if (name.length > 80) return err(400, "NAME_TOO_LONG", "Channel name is longer than 80 characters");
      const clash = channels.find((c) => (c.type === "public" || c.type === "private") && c.name.toLowerCase() === name.toLowerCase());
      if (clash) return err(409, "CHANNEL_NAME_TAKEN", "A channel with this name already exists", { channelId: clash._id });
      const extra = (Array.isArray(body.memberIds) ? body.memberIds : []).filter((id) => userById(id) && id !== ME_ID);
      const c = mkChannel(nextChan++, body.type, name, [ME_ID, ...new Set(extra)], { roles: { [ME_ID]: "owner" }, extra: { description: String(body.description ?? "") } });
      channels.push(c);
      emitChannelUpdated(c);
      return ok(serializeChannel(c), 201);
    }
    if (is("GET", "/api/chat/threads")) {
      const limit = Math.min(100, Math.max(1, Number(q.get("limit")) || 30));
      const unreadOnly = ["true", "1"].includes(q.get("unread") ?? "");
      const myIds = new Set(mine().map((c) => c._id));
      const inThread = (r) => r.sender === ME_ID || r.mentions.users.includes(ME_ID) || all.some((m) => m.threadRoot === r._id && (m.sender === ME_ID || m.mentions.users.includes(ME_ID)));
      const roots = all.filter((m) => !m.threadRoot && m.replyCount > 0 && myIds.has(m.channel) && inThread(m)).sort((a, b) => (a.lastReplyAt < b.lastReplyAt ? 1 : -1));
      const items = roots
        .map((r) => ({ root: serializeMessage(r), channel: { _id: r.channel, name: chan(r.channel).name, type: chan(r.channel).type }, replyCount: r.replyCount, lastReplyAt: r.lastReplyAt, unreadCount: threadUnread(r) }))
        .filter((t) => !unreadOnly || t.unreadCount > 0);
      return ok({ items: items.slice(0, limit) });
    }
    if (is("GET", "/api/chat/search")) {
      const term = (q.get("q") ?? "").trim().toLowerCase();
      const type = q.get("type") ?? "all";
      const want = (k) => type === "all" || type === k;
      const out = { messages: [], files: [], people: [], channels: [] };
      if (!term) return ok(out);
      if (want("messages")) {
        const visible = new Set(channels.filter((c) => c.members.has(ME_ID) || c.type === "public").map((c) => c._id));
        out.messages = all
          .filter((m) => visible.has(m.channel) && !m.deletedAt && m.kind === "text" && m.text.toLowerCase().includes(term) && (!q.get("channelId") || m.channel === q.get("channelId")))
          .reverse().slice(0, 30).map((m) => serializeMessage(m, { channelName: chan(m.channel).name }));
      }
      if (want("people")) out.people = USERS.filter((u) => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)).map(directoryItem);
      if (want("channels")) out.channels = channels.filter((c) => c.name && c.name.toLowerCase().includes(term) && (c.members.has(ME_ID) || (c.type === "public" && !c.archived))).slice(0, 30).map((c) => serializeChannel(c));
      return ok(out);
    }

    let m = /^\/api\/chat\/messages\/([A-Za-z0-9_-]+)(?:\/(thread|reactions|pin))?$/.exec(path);
    if (m) {
      const message = msg(m[1]);
      if (!message) return err(404, "MESSAGE_NOT_FOUND", "Message not found");
      const c = chan(message.channel);
      const mb = c.members.get(ME_ID);
      if (!mb && c.type !== "public") return err(403, "NOT_A_MEMBER", "Not a member of this channel");
      if (method === "GET" && m[2] === "thread") {
        const root = message.threadRoot ? msg(message.threadRoot) : message;
        markThread(ME_ID, root._id);
        return ok({ root: serializeMessage(root), items: all.filter((x) => x.threadRoot === root._id).slice(0, 500).map((x) => serializeMessage(x)) });
      }
      if (method === "PATCH" && !m[2]) {
        if (message.sender !== ME_ID) return err(403, "NOT_SENDER", "Only the sender can edit a message");
        if (message.deletedAt) return err(409, "MESSAGE_DELETED", "Message was deleted");
        if (c.archived) return err(409, "CHANNEL_ARCHIVED", "Channel is archived");
        const text = String(body.text ?? "").trim();
        if (!text) return err(400, "EMPTY_MESSAGE", "Message text is required");
        if (text.length > 8000) return err(400, "MESSAGE_TOO_LONG", "Message is longer than 8000 characters");
        message.text = text;
        message.mentions = parseMentions(text, message.mentions);
        message.editedAt = ISO(now());
        emitUpdated(message);
        return ok(serializeMessage(message));
      }
      if (method === "DELETE" && !m[2]) {
        if (message.sender !== ME_ID && !isAdmin(c)) return err(403, "DELETE_FORBIDDEN", "Only the sender or a channel admin can delete this message");
        if (!message.deletedAt) {
          message.deletedAt = ISO(now());
          if (message.threadRoot) {
            const root = msg(message.threadRoot);
            root.replyCount = Math.max(root.replyCount - 1, 0);
            emitUpdated(root);
          }
        }
        emitMembers(c, "chat:message:deleted", { channelId: c._id, messageId: message._id, threadRoot: message.threadRoot });
        return ok({ ok: true });
      }
      if (method === "POST" && m[2] === "reactions") {
        const emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";
        if (!emoji || emoji.length > 32) return err(400, "INVALID_EMOJI", "Invalid emoji");
        if (message.deletedAt) return err(409, "MESSAGE_DELETED", "Message was deleted");
        let r = message.reactions.find((x) => x.emoji === emoji);
        if (!r) message.reactions.push((r = { emoji, users: [] }));
        r.users = r.users.includes(ME_ID) ? r.users.filter((u) => u !== ME_ID) : [...r.users, ME_ID];
        message.reactions = message.reactions.filter((x) => x.users.length);
        emitUpdated(message);
        return ok(serializeMessage(message));
      }
      if (method === "POST" && m[2] === "pin") {
        if (message.deletedAt) return err(409, "MESSAGE_DELETED", "Message was deleted");
        message.pinned = body.pinned !== false;
        message.pinnedBy = message.pinned ? ME_ID : null;
        emitUpdated(message);
        emitChannelUpdated(c);
        return ok(serializeMessage(message));
      }
      return undefined;
    }

    m = /^\/api\/chat\/channels\/([A-Za-z0-9_-]+)(?:\/(messages|read|members|join|leave|preferences)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(path);
    if (!m) return undefined;
    const [, id, sub, subId] = m;
    const res = needChannel(id, { member: ["read", "leave", "preferences"].includes(sub) || (sub === "messages" && method === "POST") });
    if (res.e) return res.e;
    const { c, mb } = res;

    if (!sub) {
      if (method === "GET") return ok(serializeChannel(c));
      if (method === "PATCH") {
        if (!mb) return err(403, "NOT_A_MEMBER", "Not a member of this channel");
        if (body.name !== undefined) {
          if (c.type === "direct" || c.type === "group") return err(400, "DIRECT_IMMUTABLE", "Direct messages cannot be renamed");
          if (!isAdmin(c)) return err(403, "MANAGE_FORBIDDEN", "Only channel admins can rename a channel");
          const name = String(body.name).trim();
          if (!name) return err(400, "NAME_REQUIRED", "Channel name is required");
          if (name.length > 80) return err(400, "NAME_TOO_LONG", "Channel name is longer than 80 characters");
          if (channels.some((x) => x !== c && x.name.toLowerCase() === name.toLowerCase() && (x.type === "public" || x.type === "private"))) return err(409, "CHANNEL_NAME_TAKEN", "A channel with this name already exists");
          c.name = name;
        }
        if (body.description !== undefined) c.description = String(body.description);
        if (body.topic !== undefined) c.topic = String(body.topic);
        emitChannelUpdated(c);
        return ok(serializeChannel(c));
      }
      return undefined;
    }
    if (sub === "messages") {
      if (method === "GET") return listMessages(c, q);
      if (method === "POST") return send(c, body);
    }
    if (sub === "read" && method === "POST") return markRead(c, mb, body);
    if (sub === "join" && method === "POST") {
      if (c.type !== "public") return err(403, "JOIN_FORBIDDEN", "Only public channels can be joined");
      if (c.archived) return err(409, "CHANNEL_ARCHIVED", "Channel is archived");
      if (!mb) {
        c.members.set(ME_ID, member("member", { lastReadMessageId: tops(c).at(-1)?._id ?? null, lastReadAt: ISO(now()) }));
        system(c, `${USERS[0].name} joined the channel`, { type: "member.joined", actor: USERS[0].name, names: USERS[0].name });
        emitChannelUpdated(c);
      }
      return ok(serializeChannel(c));
    }
    if (sub === "leave" && method === "POST") {
      if (c.type === "direct") {
        mb.hidden = true;
        emitUser(ME_ID, "chat:channel:removed", { channelId: c._id });
        return ok({ ok: true });
      }
      c.members.delete(ME_ID);
      emitUser(ME_ID, "chat:channel:removed", { channelId: c._id });
      emitChannelUpdated(c);
      return ok({ ok: true });
    }
    if (sub === "preferences" && method === "PATCH") {
      if (body.notifyLevel !== undefined) {
        if (!["all", "mentions", "none"].includes(body.notifyLevel)) return err(400, "INVALID_NOTIFY_LEVEL", "notifyLevel must be all, mentions or none");
        mb.notifyLevel = body.notifyLevel;
      }
      if (body.mutedUntil !== undefined) {
        if (body.mutedUntil !== null && Number.isNaN(Date.parse(body.mutedUntil))) return err(400, "INVALID_MUTED_UNTIL", "mutedUntil must be an ISO date or null");
        mb.mutedUntil = body.mutedUntil === null ? null : ISO(Date.parse(body.mutedUntil));
      }
      for (const k of ["starred", "hidden"]) {
        if (body[k] === undefined) continue;
        if (typeof body[k] !== "boolean") return err(400, "INVALID_PREFERENCE", `${k} must be a boolean`);
        mb[k] = body[k];
      }
      emitUser(ME_ID, "chat:channel:updated", { channel: serializeChannel(c) });
      return ok(serializeChannel(c));
    }
    if (sub === "members") {
      if (method === "GET" && !subId) return ok({ items: [...c.members.keys()].map((u) => serializeMember(c, u)) });
      if (method === "POST" && !subId) {
        if (c.type === "direct" || c.type === "group") return err(400, "DIRECT_IMMUTABLE", "Members cannot be added to a direct conversation");
        if (c.archived) return err(409, "CHANNEL_ARCHIVED", "Channel is archived");
        if (c.type !== "public" && !isAdmin(c)) return err(403, "MANAGE_FORBIDDEN", "Only channel admins can add members here");
        const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String).filter(isId))];
        if (!ids.length) return err(400, "USERS_REQUIRED", "userIds is required");
        const staff = ids.filter((u) => userById(u));
        if (!staff.length) return err(403, "USERS_NOT_ALLOWED", "None of these users can join this channel");
        const added = staff.filter((u) => !c.members.has(u));
        for (const u of added) c.members.set(u, member("member", { lastReadMessageId: tops(c).at(-1)?._id ?? null, lastReadAt: ISO(now()) }));
        if (added.length) {
          system(c, `${USERS[0].name} added ${added.map((u) => userById(u).name).join(", ")}`, { type: "members.added", actor: USERS[0].name, names: added.map((u) => userById(u).name).join(", ") });
          emitChannelUpdated(c);
        }
        return ok({ items: [...c.members.keys()].map((u) => serializeMember(c, u)) });
      }
      if (method === "DELETE" && subId) {
        if (!isId(subId)) return err(400, "INVALID_USER_ID", "Invalid userId");
        const self = subId === ME_ID;
        if ((c.type === "direct" || c.type === "group") && !self) return err(400, "DIRECT_IMMUTABLE", "Members cannot be removed from a direct conversation");
        if (!self && !isAdmin(c)) return err(403, "MANAGE_FORBIDDEN", "Only channel admins can remove members");
        const target = c.members.get(subId);
        if (!target) return err(404, "MEMBER_NOT_FOUND", "User is not a member of this channel");
        if (!self && target.role === "owner") return err(403, "OWNER_PROTECTED", "The channel owner cannot be removed");
        c.members.delete(subId);
        emitUser(subId, "chat:channel:removed", { channelId: c._id });
        emitChannelUpdated(c);
        return ok({ ok: true });
      }
    }
    return undefined;
  };

  return {
    controls: Object.keys(controls),
    control: (path, body) => controls[path]?.(body ?? {}),
    reset() {
      io?.disconnectSockets(true);
      fill();
      sockLog.connects = 0;
      sockLog.joined = [];
      sockLog.received = [];
    },
    startedMeetings: () => started,
    endedMeetings: () => ended,
    dropSockets: () => io?.disconnectSockets(true),
    /** Attaches the Socket.IO server to the HTTP server. Returns false when the `socket.io` package is not installed. */
    async attach(httpServer) {
      let Server;
      try {
        ({ Server } = await import("socket.io"));
      } catch {
        return false;
      }
      io = new Server(httpServer, { serveClient: false, cors: false, pingInterval: 25_000, pingTimeout: 20_000 });
      io.use((socket, next) => {
        const a = socket.handshake.auth ?? {};
        if (rejectMode === "forbidden") return next(new Error("forbidden"));
        if (rejectMode === "unauthorized" || a.token !== token() || !a.userId) return next(new Error("unauthorized"));
        next();
      });
      io.on("connection", (socket) => {
        sockLog.connects += 1;
        socket.on("join:user", (id) => {
          if (forbidJoin) return socket.emit("join:forbidden", { room: `user:${id}` });
          socket.join(`user:${id}`);
          sockLog.joined.push(id);
        });
        socket.on("chat:typing", (p) => {
          sockLog.received.push({ event: "chat:typing", channelId: p?.channelId });
          const c = chan(p?.channelId);
          if (c) for (const id of c.members.keys()) if (id !== ME_ID) emitUser(id, "chat:typing", { channelId: c._id, userId: ME_ID, name: USERS[0].name });
        });
      });
      return true;
    },
    closeSockets() {
      io?.disconnectSockets(true);
      io?.engine?.close();
    },
    /** `{status, body}` for a chat route, or undefined when the route is not ours. */
    handle,
  };
}
