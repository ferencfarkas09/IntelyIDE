import type { ChatChannel, ChatEvent, ChatKind, ChatLink, ChatMember, ChatMessage, ChatPerson, ChatPreferences, ChatSummary, HappyChatIpc, MessagePage, ThreadSummary } from "../happyChat";

export type ChatScenario = "ok" | "empty" | "offline" | "signedout" | "forbidden" | "nocredits" | "big" | "notenabled";
const SCENARIOS: readonly ChatScenario[] = ["ok", "empty", "offline", "signedout", "forbidden", "nocredits", "big", "notenabled"];

/** `?chat=ok|empty|offline|signedout|forbidden|nocredits|big|notenabled` in the dev URL picks what the mock chat looks like (with `?happy=connected`). */
export function chatScenarioFromUrl(): ChatScenario {
  const v = new URLSearchParams(globalThis.location?.search).get("chat");
  return SCENARIOS.includes(v as ChatScenario) ? (v as ChatScenario) : "ok";
}

export const MOCK_ME = { id: "u_1", name: "Teszt Elek" };

const PEOPLE: ChatPerson[] = [
  { id: "u_2", name: "Kovács Anna", detail: "Backend" },
  { id: "u_3", name: "Nagy Péter", detail: "Frontend" },
  { id: "u_4", name: "Szabó Réka", detail: "Support" },
  { id: "u_5", name: "Tóth Gábor", detail: "Ops" },
  { id: "u_6", name: "Horváth Dóra", detail: "Design" },
];

const MIN = 60_000;
const PAGE = 50;
const PAGE_LIMIT = 8000;

const SCRIPTS: Record<string, string[]> = {
  c_general: [
    "Jó reggelt mindenkinek!",
    "Szia! A mai standup 10:00-kor lesz, a megszokott szobában.",
    "Köszi, ott leszek. A sprint review előtt még átnézem a nyitott PR-okat.",
    "Itt a leírás a pénztári hibáról: https://github.com/happy/pos/pull/482 (a megoldás már fent van).",
    "Ez a http://old.example.test/status oldal már nem él, de nem nyílik meg böngészőben.",
    "@Teszt Elek megnéznéd a számlázási exportot? Holnap reggelre kellene.",
    "Persze, ebéd után ránézek.",
    "A VPN ma lassú, valaki tapasztalja ugyanezt?",
    "Nálam is, a Wi-Fi miatt lehet. Kábelen minden gyors.",
    "Ebéd 12:30-kor, aki jön, szóljon!",
  ],
  c_dev: [
    "A `main` ág zöld, a deploy rendben lefutott.",
    "Frissítettem a lokalizációs kulcsokat, a hu és en fájlokat is.",
    "Van egy flaky teszt a nyugtanyomtatásnál, kinyitok rá egy jegyet.",
    "Review-t kérek a https://github.com/happy/admin/pull/1290 PR-ra, nem nagy.",
    "Megnéztem, két apróság van, megjegyzések a PR-ban.",
    "@Nagy Péter a refund képernyőn a gomb még mindig nem a design szerinti.",
    "Javítom, délutánra kész.",
    "Köszi! Közben a CI is lefutott.",
  ],
  c_ops: [
    "A sandbox szerver újraindult 03:10-kor, minden szolgáltatás visszaállt.",
    "A mentés 02:00-kor lefutott, 4,2 GB.",
    "Disk használat 71%, figyeljük.",
    "A cron job lista frissítve, a takarítás átkerült éjszakára.",
    "Figyelmeztetés: a TLS tanúsítvány 14 nap múlva lejár.",
  ],
  c_random: ["Valaki látta a tegnapi meccset?", "Az iroda új kávégépe hibátlan.", "Péntek délután sütit hozok.", "Kérlek ne az utolsó szeletet!"],
  d_anna: ["Szia Elek, van egy perced?", "Kérdésem lenne a számlázási exportról.", "Persze, mondd!", "A CSV-ben a dátumok UTC-ben vannak, jó ez így?", "Igen, azt így tárolja az API. Átállítom helyi időre a kiírásnál."],
  d_peter: ["Köszi a segítséget tegnap!", "Nincs mit. Jó lett a megoldás?", "Igen, azóta nincs hiba."],
  c_management: ["A negyedéves célok a mellékletben vannak.", "Jóváhagytam a keretet.", "Péntekig kérem a visszajelzéseket."],
  c_hr: ["Emlékeztető: a szabadságkérelmeket a hónap végéig kell leadni.", "Köszönjük, minden csapat megkapta.", "Az új belépők listája frissült."],
  c_design: ["Feltöltöttem az új ikonkészletet.", "A sötét téma kontrasztjait átnéztem.", "Holnap mutatom a pénztár prototípust."],
  g_u_2_u_3: ["Mikor ebédelünk?", "Én 12:30-ra érek oda.", "Jó, akkor találkozunk a bejáratnál."],
};

const NAMES: Record<string, string[]> = {
  c_general: ["u_2", "u_3", "u_1", "u_2", "u_5", "u_2", "u_1", "u_4", "u_3", "u_5"],
  c_dev: ["u_3", "u_2", "u_5", "u_3", "u_1", "u_2", "u_3", "u_2"],
  c_ops: ["u_5", "u_5", "u_5", "u_5", "u_5"],
  c_random: ["u_6", "u_4", "u_6", "u_3"],
  d_anna: ["u_2", "u_2", "u_1", "u_2", "u_1"],
  d_peter: ["u_3", "u_1", "u_3"],
  c_management: ["u_5", "u_1", "u_5"],
  c_hr: ["u_4", "u_4", "u_4"],
  c_design: ["u_6", "u_6", "u_6"],
  g_u_2_u_3: ["u_2", "u_3", "u_2"],
};

const nameOf = (id: string): string => (id === MOCK_ME.id ? MOCK_ME.name : (PEOPLE.find((p) => p.id === id)?.name ?? id));


const personOf = (id: string): ChatPerson => ({ id, name: nameOf(id) });
const refuse = (code: string, message: string) => ({ code, message });

/** A complete message with sensible defaults for everything the caller does not set. */
function msg(o: Partial<ChatMessage> & Pick<ChatMessage, "id" | "channelId" | "senderId" | "text" | "createdAtMs">): ChatMessage {
  return {
    senderName: nameOf(o.senderId),
    edited: false,
    deleted: false,
    system: false,
    mine: o.senderId === MOCK_ME.id,
    mentionsMe: false,
    sendState: "sent",
    kind: "text",
    replyCount: 0,
    replyUsers: [],
    reactions: [],
    attachments: [],
    pinned: false,
    ...o,
  };
}

export interface MockChatEnv {
  now: () => number;
  scenario: ChatScenario;
  /** Throws the connection-level error (`notConnected`, `signedOut`) the real thing throws when the provider is not up. */
  requireOn: () => void;
}

export interface MockChatSim {
  /** A top-level message from somebody else arrives (live), optionally mentioning the user. */
  receive(channelId: string, text: string, from?: string): ChatMessage;
  /** A thread reply from somebody else arrives: a `new` event with `threadRoot`, an `updated` event of the root, thread-unread +1 (unless that thread was the last one opened). */
  receiveReply(rootId: string, text: string, from?: string): ChatMessage;
  /** Sets the unread reply count of a thread (and emits the summary with the new `threadUnread`). */
  markThreadUnread(rootId: string, n: number): void;
  typing(channelId: string, names: string[]): void;
  setLink(link: ChatLink): void;
  setCredits(credits: number): void;
  /** Changes what the summary says the user may do (`canCreateChannel`, `canManageChannels`). */
  setPermissions(p: { canCreateChannel?: boolean; canManageChannels?: boolean }): void;
  /** The next `send` rejects with this code (once). */
  failNext(code: string, message?: string): void;
  /** Sends stay `pending` for this long before they resolve. */
  setSendDelay(ms: number): void;
  /** Which channel the user is looking at (what `open` set), for assertions. */
  viewing(): string | undefined;
  /** Every `markRead` call, for assertions. */
  readCalls(): string[];
}

export interface MockChat {
  api: HappyChatIpc;
  sim: MockChatSim;
  /** The summary now. */
  current(): ChatSummary;
}

interface SeedOpts {
  muted?: boolean;
  topic?: string;
  description?: string;
  role?: "admin" | "member";
  peers?: ChatPerson[];
  isMember?: boolean;
  members?: string[];
}

/**
 * An in-memory Team chat: public/private/direct/group channels, people, Hungarian messages over two days, threads, a channel to
 * browse, the real refusals (`DIRECT_IMMUTABLE`, `MANAGE_FORBIDDEN`, ...), the 402 and offline states.
 */
export function createMockChat(env: MockChatEnv): MockChat {
  const now = env.now;
  const scenario = env.scenario;
  let seq = 0;
  const listeners = new Set<(e: ChatEvent) => void>();
  const emit = (e: ChatEvent) => listeners.forEach((cb) => cb(e));

  let credits = scenario === "nocredits" ? 0 : 12.46;
  let creditsEmpty = scenario === "nocredits";
  let link: ChatLink = scenario === "offline" ? "reconnecting" : "live";
  const sendCost = 0.02;
  let viewed: string | undefined;
  let openedThread: string | undefined;
  let failure: { code: string; message: string } | undefined;
  let sendDelay = 0;
  let canCreateChannel = true;
  let canManageChannels = true;
  const reads: string[] = [];

  const channels = new Map<string, ChatChannel>();
  /** The top-level messages of each channel, oldest first. */
  const messages = new Map<string, ChatMessage[]>();
  /** The replies of each thread root, oldest first. */
  const replies = new Map<string, ChatMessage[]>();
  const threadUnread = new Map<string, number>();
  const memberIds = new Map<string, string[]>();

  const seed = (id: string, kind: ChatKind, name: string, unread: number, mention: number, count: number, opts: SeedOpts = {}) => {
    const script = SCRIPTS[id]!;
    const who = NAMES[id]!;
    const list: ChatMessage[] = new Array<ChatMessage>(count);
    // The newest message is two minutes old; the last eight are minutes apart, the older ones one to two hours.
    let t = now() - 2 * MIN;
    for (let i = count - 1; i >= 0; i--) {
      const k = i % script.length;
      const senderId = who[k % who.length]!;
      const text = count <= script.length || i >= count - script.length ? script[k]! : `${script[k]} (${i + 1})`;
      list[i] = msg({ id: `m_${id}_${i + 1}`, channelId: id, senderId, text, createdAtMs: t });
      t -= (i >= count - 8 ? 3 : 60 + ((i * 17) % 61)) * MIN;
    }
    // The unread messages come from others; the last `mention` of them mention the user.
    for (let i = Math.max(0, count - unread); i < count; i++) {
      const m = list[i]!;
      if (m.mine) {
        const other = PEOPLE[i % PEOPLE.length]!;
        Object.assign(m, { senderId: other.id, senderName: other.name, mine: false });
      }
      if (i >= count - mention) Object.assign(m, { text: `@${MOCK_ME.name} ${m.text}`, mentionsMe: true });
    }
    messages.set(id, list);
    const direct = kind === "direct" || kind === "group";
    const ids = opts.members ?? (direct ? [MOCK_ME.id, ...(opts.peers ?? []).map((p) => p.id)] : [MOCK_ME.id, ...PEOPLE.map((p) => p.id)]);
    memberIds.set(id, ids);
    const last = list.at(-1);
    channels.set(id, {
      id,
      kind,
      name,
      unreadCount: unread,
      mentionCount: mention,
      muted: opts.muted ?? false,
      notifyLevel: opts.muted ? "none" : direct ? "all" : "mentions",
      lastMessageAtMs: last?.createdAtMs ?? null,
      topic: opts.topic ?? "",
      description: opts.description ?? "",
      memberCount: ids.length,
      archived: false,
      starred: false,
      isMember: opts.isMember ?? true,
      role: opts.isMember === false ? null : (opts.role ?? "member"),
      peers: opts.peers ?? [],
      lastPreview: last?.text ?? null,
      lastSender: last?.senderName ?? null,
    });
  };

  const refreshRoot = (root: ChatMessage) => {
    const list = replies.get(root.id) ?? [];
    root.replyCount = list.length;
    root.lastReplyAtMs = list.at(-1)?.createdAtMs ?? null;
    const users: ChatPerson[] = [];
    for (const r of list) if (!users.some((u) => u.id === r.senderId)) users.push(personOf(r.senderId));
    root.replyUsers = users;
  };
  /** A thread seeded onto an existing message: `spec` are (sender, text) pairs; `unread` replies count as news for the user. */
  const seedThread = (channelId: string, index: number, spec: [string, string][], unread = 0) => {
    const root = messages.get(channelId)?.[index];
    if (!root) return;
    const list = spec.map(([senderId, text], k) => msg({ id: `r_${root.id}_${k + 1}`, channelId, senderId, text, createdAtMs: Math.min(now() - MIN, root.createdAtMs + (k + 1) * 4 * MIN), threadRoot: root.id }));
    replies.set(root.id, list);
    refreshRoot(root);
    if (unread) threadUnread.set(root.id, unread);
  };

  if (scenario !== "empty") {
    seed("c_general", "channel", "general", 3, 1, 28, { topic: "Napi egyeztetések és általános kérdések", description: "A teljes csapat közös csatornája.", role: "member" });
    seed("c_dev", "channel", "dev", 0, 0, scenario === "big" ? 420 : 46, { topic: "Fejlesztés, review, deploy", description: "Fejlesztési témák, PR-ok és kiadások.", role: "admin" });
    seed("c_ops", "channel", "ops", 14, 0, scenario === "big" ? 300 : 24, { topic: "Üzemeltetés és monitoring", role: "member" });
    seed("c_random", "channel", "random", 5, 0, 12, { muted: true });
    seed("c_management", "private", "management", 0, 0, 6, { topic: "Vezetői egyeztetés", description: "Privát csatorna a vezetőknek.", role: "admin", members: ["u_1", "u_5"] });
    seed("c_hr", "private", "hr-ugyek", 0, 0, 6, { topic: "HR közlemények", role: "member", members: ["u_1", "u_4", "u_5"] });
    seed("c_design", "channel", "design", 0, 0, 6, { topic: "UI és arculat", description: "Design rendszer, ikonok, prototípusok.", isMember: false });
    seed("d_anna", "direct", "Kovács Anna", 1, 0, 10, { peers: [PEOPLE[0]!] });
    seed("d_peter", "direct", "Nagy Péter", 0, 0, 6, { peers: [PEOPLE[1]!] });
    seed("g_u_2_u_3", "group", "Kovács Anna, Nagy Péter", 0, 0, 6, { peers: [PEOPLE[0]!, PEOPLE[1]!] });
    seedThread("c_dev", 3, [["u_2", "Megnéztem, szerintem a második pont a lényeg."], ["u_1", "Köszi, átírom."], ["u_2", "Rendben, akkor jóváhagyom."]]);
    seedThread("c_general", 3, [["u_2", "Köszönöm, ez sokat segít!"], ["u_3", "A javítás a 2.4-es kiadással megy ki."]], 1);
    seedThread("c_ops", 2, [["u_5", "A riasztás küszöbét 80%-ra állítottam."]]);
  }

  const visible = () => [...channels.values()].filter((c) => c.isMember && !c.archived);
  const summary = (): ChatSummary => {
    const list = visible();
    return {
      channels: list.map((c) => ({ ...c, peers: c.peers.map((p) => ({ ...p })) })),
      unreadTotal: list.reduce((n, c) => n + (c.muted ? 0 : c.unreadCount), 0),
      mentionTotal: list.reduce((n, c) => n + c.mentionCount, 0),
      threadUnread: [...threadUnread.values()].filter((n) => n > 0).length,
      canCreateChannel,
      canManageChannels,
      credits,
      sendCost,
      creditsEmpty,
      link,
      stale: scenario === "offline",
      loaded: true,
    };
  };
  const emitSummary = () => emit({ type: "summary", summary: summary() });

  const need = (id: string): ChatChannel => {
    const c = channels.get(id);
    if (!c) throw refuse("notFound", "No such conversation");
    return c;
  };
  const isDirect = (c: ChatChannel) => c.kind === "direct" || c.kind === "group";
  const copy = <T,>(v: T): T => structuredClone(v);
  const page = (channelId: string, start: number, end: number, extra: Partial<MessagePage> = {}): MessagePage => {
    const all = messages.get(channelId) ?? [];
    return { channelId, messages: all.slice(start, end).map(copy), hasMore: start > 0, cursor: start > 0 ? all[start]!.id : null, hasNewer: end < all.length, anchorId: null, ...extra };
  };
  const rootOf = (rootId: string): { channel: ChatChannel; root: ChatMessage } | undefined => {
    for (const [channelId, list] of messages) {
      const root = list.find((m) => m.id === rootId);
      if (root) return { channel: need(channelId), root };
    }
    return undefined;
  };
  const findMessage = (id: string): ChatMessage | undefined => {
    for (const list of messages.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    for (const list of replies.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    return undefined;
  };
  const emitMessage = (m: ChatMessage, change: "new" | "updated" | "deleted" | "replaced", notify = false) => emit({ type: "message", channelId: m.channelId, message: copy(m), change, notify });
  const updateLast = (c: ChatChannel) => {
    const last = messages.get(c.id)?.filter((m) => !m.deleted).at(-1);
    c.lastMessageAtMs = last?.createdAtMs ?? c.lastMessageAtMs ?? null;
    c.lastPreview = last?.text ?? null;
    c.lastSender = last?.senderName ?? null;
  };

  /** Puts a new/replaced message where it belongs: a reply into its thread (root updated, channel unread untouched), the rest into the channel. */
  const deliver = (m: ChatMessage, change: "new" | "replaced") => {
    const c = channels.get(m.channelId);
    if (!c) return;
    if (m.threadRoot) {
      const root = messages.get(m.channelId)?.find((x) => x.id === m.threadRoot);
      if (!root) return;
      const list = replies.get(root.id) ?? [];
      list.push(m);
      replies.set(root.id, list);
      refreshRoot(root);
      const mineRoot = root.mine || list.some((r) => r.mine);
      if (!m.mine && openedThread !== root.id) threadUnread.set(root.id, (threadUnread.get(root.id) ?? 0) + 1);
      emitMessage(m, change, !m.mine && (m.mentionsMe || mineRoot || c.notifyLevel === "all"));
      emitMessage(root, "updated");
      emitSummary();
      return;
    }
    const list = messages.get(m.channelId) ?? [];
    list.push(m);
    messages.set(m.channelId, list);
    c.lastMessageAtMs = m.createdAtMs;
    c.lastPreview = m.text;
    c.lastSender = m.senderName;
    let notify = false;
    if (!m.mine && change === "new") {
      if (viewed !== m.channelId) {
        c.unreadCount += 1;
        if (m.mentionsMe) c.mentionCount += 1;
        notify = c.notifyLevel === "all" || (c.notifyLevel === "mentions" && (m.mentionsMe || isDirect(c)));
      }
    }
    emitMessage(m, change, notify);
    emitSummary();
  };

  // ---- permissions ----
  const manageFailure = (c: ChatChannel): { code: string; message: string } | undefined => {
    if (isDirect(c)) return refuse("DIRECT_IMMUTABLE", "Direct and group conversations cannot be changed");
    if (c.role !== "admin" && (c.kind === "private" || !canManageChannels)) return refuse("MANAGE_FORBIDDEN", "This channel needs a channel admin");
    return undefined;
  };
  const memberOf = (id: string, channel: ChatChannel): ChatMember => ({ id, name: nameOf(id), email: id === MOCK_ME.id ? null : `${id}@example.test`, role: id === MOCK_ME.id ? (channel.role ?? "member") : "member", online: id === "u_2" || id === "u_3", portal: false });
  const nameTaken = (name: string, except?: string) => [...channels.values()].some((c) => c.id !== except && !isDirect(c) && c.name.toLowerCase() === name.toLowerCase());

  const api: HappyChatIpc = {
    async summary() {
      env.requireOn();
      return summary();
    },
    async open(channelId) {
      env.requireOn();
      need(channelId);
      viewed = channelId;
      const n = messages.get(channelId)?.length ?? 0;
      return page(channelId, Math.max(0, n - PAGE), n);
    },
    async setActive(open, channelId) {
      viewed = open ? (channelId ?? undefined) : undefined;
    },
    async older(channelId, cursor) {
      env.requireOn();
      const all = messages.get(channelId) ?? [];
      const at = all.findIndex((m) => m.id === cursor);
      const end = at < 0 ? 0 : at;
      return page(channelId, Math.max(0, end - PAGE), end);
    },
    async around(channelId, messageId) {
      env.requireOn();
      const all = messages.get(need(channelId).id) ?? [];
      const at = all.findIndex((m) => m.id === messageId);
      if (at < 0) throw refuse("notFound", "No such message");
      const start = Math.max(0, at - PAGE / 2);
      return page(channelId, start, Math.min(all.length, start + PAGE), { anchorId: messageId });
    },
    async newer(channelId, afterMessageId) {
      env.requireOn();
      const all = messages.get(need(channelId).id) ?? [];
      const at = all.findIndex((m) => m.id === afterMessageId);
      if (at < 0) throw refuse("notFound", "No such message");
      return page(channelId, at + 1, Math.min(all.length, at + 1 + PAGE));
    },
    async send(channelId, text, clientMessageId, options) {
      env.requireOn();
      need(channelId);
      const body = text.trim();
      if (!body) throw refuse("validation", "A message cannot be empty");
      if (text.length > PAGE_LIMIT) throw refuse("validation", `A message can have at most ${PAGE_LIMIT} characters`);
      const rootId = options?.threadRootId;
      if (rootId && !messages.get(channelId)?.some((m) => m.id === rootId)) throw refuse("notFound", "No such thread");
      const known = (rootId ? replies.get(rootId) : messages.get(channelId))?.find((m) => m.clientMessageId === clientMessageId);
      if (known) return copy(known);
      if (failure) {
        const f = failure;
        failure = undefined;
        throw refuse(f.code, f.message);
      }
      if (creditsEmpty) throw refuse("INSUFFICIENT_CREDITS", "Your store has no chat credits left");
      if (sendDelay) await new Promise((r) => setTimeout(r, sendDelay));
      const m = msg({ id: `${rootId ? "r" : "m"}_${channelId}_${++seq + 1000}`, channelId, clientMessageId, senderId: MOCK_ME.id, text: body, createdAtMs: now(), threadRoot: rootId ?? null });
      credits = Math.max(0, Math.round((credits - sendCost) * 100) / 100);
      if (credits <= 0) creditsEmpty = true;
      deliver(m, "replaced");
      return copy(m);
    },
    async markRead(channelId) {
      env.requireOn();
      const c = need(channelId);
      reads.push(channelId);
      if (c.unreadCount || c.mentionCount) {
        c.unreadCount = 0;
        c.mentionCount = 0;
        emitSummary();
      }
    },
    async typing(channelId) {
      env.requireOn();
      need(channelId);
    },
    async people(query) {
      env.requireOn();
      const q = (query ?? "").trim().toLowerCase();
      return PEOPLE.filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => ({ ...p }));
    },
    async direct(personIds) {
      env.requireOn();
      const ids = [...new Set(Array.isArray(personIds) ? personIds : [personIds])];
      if (!ids.length || ids.length > 7) throw refuse("USERS_REQUIRED", "Pick between one and seven people");
      const people = ids.map((id) => PEOPLE.find((p) => p.id === id) ?? (() => { throw refuse("notFound", "No such person"); })());
      const kind: ChatKind = people.length === 1 ? "direct" : "group";
      const key = [...ids].sort().join(",");
      const existing = [...channels.values()].find((c) => c.kind === kind && [...c.peers.map((p) => p.id)].sort().join(",") === key);
      if (existing) return copy(existing);
      const c: ChatChannel = {
        id: kind === "direct" ? `d_${ids[0]}` : `g_${[...ids].sort().join("_")}`,
        kind,
        name: people.map((p) => p.name).join(", "),
        unreadCount: 0,
        mentionCount: 0,
        muted: false,
        notifyLevel: "all",
        lastMessageAtMs: null,
        topic: "",
        description: "",
        memberCount: people.length + 1,
        archived: false,
        starred: false,
        isMember: true,
        role: "member",
        peers: people.map((p) => ({ ...p })),
        lastPreview: null,
        lastSender: null,
      };
      channels.set(c.id, c);
      messages.set(c.id, []);
      memberIds.set(c.id, [MOCK_ME.id, ...ids]);
      emitSummary();
      return copy(c);
    },

    async thread(rootId) {
      env.requireOn();
      const found = rootOf(rootId);
      if (!found) throw refuse("notFound", "No such thread");
      openedThread = rootId;
      if (threadUnread.delete(rootId)) emitSummary();
      return { channelId: found.channel.id, root: copy(found.root), replies: (replies.get(rootId) ?? []).map(copy) };
    },
    async threads(unreadOnly) {
      env.requireOn();
      const out: ThreadSummary[] = [];
      for (const [rootId, list] of replies) {
        const found = rootOf(rootId);
        if (!found || !list.length || !found.channel.isMember) continue;
        const unread = threadUnread.get(rootId) ?? 0;
        if (unreadOnly && !unread) continue;
        out.push({ root: copy(found.root), channelId: found.channel.id, channelName: found.channel.name, channelKind: found.channel.kind, replyCount: list.length, lastReplyAtMs: list.at(-1)!.createdAtMs, unreadCount: unread });
      }
      return out.sort((a, b) => (b.lastReplyAtMs ?? 0) - (a.lastReplyAtMs ?? 0));
    },

    async browse(query) {
      env.requireOn();
      const q = (query ?? "").trim().toLowerCase();
      return [...channels.values()].filter((c) => c.kind === "channel" && !c.isMember && !c.archived && (!q || c.name.toLowerCase().includes(q) || c.topic.toLowerCase().includes(q))).map(copy);
    },
    async createChannel(input) {
      env.requireOn();
      if (!canCreateChannel) throw refuse("CREATE_FORBIDDEN", "You cannot create channels");
      const name = input.name.trim();
      if (!name) throw refuse("NAME_REQUIRED", "A channel needs a name");
      if (nameTaken(name)) throw refuse("CHANNEL_NAME_TAKEN", "A channel with this name already exists");
      const ids = [MOCK_ME.id, ...(input.memberIds ?? []).filter((id) => id !== MOCK_ME.id && PEOPLE.some((p) => p.id === id))];
      const c: ChatChannel = {
        id: `c_new_${++seq}`,
        kind: input.private ? "private" : "channel",
        name,
        unreadCount: 0,
        mentionCount: 0,
        muted: false,
        notifyLevel: "mentions",
        lastMessageAtMs: null,
        topic: "",
        description: input.description?.trim() ?? "",
        memberCount: ids.length,
        archived: false,
        starred: false,
        isMember: true,
        role: "admin",
        peers: [],
        lastPreview: null,
        lastSender: null,
      };
      channels.set(c.id, c);
      messages.set(c.id, []);
      memberIds.set(c.id, ids);
      emitSummary();
      return copy(c);
    },
    async join(channelId) {
      env.requireOn();
      const c = need(channelId);
      if (c.kind !== "channel") throw refuse("MANAGE_FORBIDDEN", "Only public channels can be joined");
      if (!c.isMember) {
        c.isMember = true;
        c.role = "member";
        const ids = memberIds.get(c.id) ?? [];
        if (!ids.includes(MOCK_ME.id)) ids.push(MOCK_ME.id);
        memberIds.set(c.id, ids);
        c.memberCount = ids.length;
        emitSummary();
      }
      return copy(c);
    },
    async leave(channelId) {
      env.requireOn();
      const c = need(channelId);
      if (isDirect(c)) throw refuse("DIRECT_IMMUTABLE", "Direct and group conversations cannot be left");
      c.isMember = false;
      c.role = null;
      memberIds.set(c.id, (memberIds.get(c.id) ?? []).filter((id) => id !== MOCK_ME.id));
      c.memberCount = memberIds.get(c.id)!.length;
      if (viewed === channelId) viewed = undefined;
      emitSummary();
    },
    async updateChannel(channelId, patch) {
      env.requireOn();
      const c = need(channelId);
      const refused = manageFailure(c);
      if (refused) throw refused;
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw refuse("NAME_REQUIRED", "A channel needs a name");
        if (nameTaken(name, c.id)) throw refuse("CHANNEL_NAME_TAKEN", "A channel with this name already exists");
        c.name = name;
      }
      if (patch.description !== undefined) c.description = patch.description;
      if (patch.topic !== undefined) c.topic = patch.topic;
      emitSummary();
      return copy(c);
    },
    async setPreferences(channelId, prefs: ChatPreferences) {
      env.requireOn();
      const c = need(channelId);
      if (prefs.notifyLevel) c.notifyLevel = prefs.notifyLevel;
      if (prefs.mutedUntilMs !== undefined) c.muted = prefs.mutedUntilMs > now();
      if (prefs.starred !== undefined) c.starred = prefs.starred;
      emitSummary();
      return copy(c);
    },

    async members(channelId) {
      env.requireOn();
      const c = need(channelId);
      return (memberIds.get(c.id) ?? []).map((id) => memberOf(id, c));
    },
    async addMembers(channelId, userIds) {
      env.requireOn();
      const c = need(channelId);
      if (isDirect(c)) throw refuse("DIRECT_IMMUTABLE", "Nobody can be invited into a direct or group conversation");
      if (c.kind === "private" && c.role !== "admin") throw refuse("MANAGE_FORBIDDEN", "This private channel needs a channel admin");
      if (!userIds.length) throw refuse("USERS_REQUIRED", "Pick at least one person");
      const ids = memberIds.get(c.id) ?? [];
      const added: ChatMember[] = [];
      for (const id of userIds) {
        if (!PEOPLE.some((p) => p.id === id)) throw refuse("notFound", "No such person");
        if (ids.includes(id)) continue;
        ids.push(id);
        added.push(memberOf(id, c));
      }
      memberIds.set(c.id, ids);
      c.memberCount = ids.length;
      emitSummary();
      return added;
    },
    async removeMember(channelId, userId) {
      env.requireOn();
      const c = need(channelId);
      if (isDirect(c)) throw refuse("DIRECT_IMMUTABLE", "Nobody can be removed from a direct or group conversation");
      if (userId !== MOCK_ME.id && c.role !== "admin") throw refuse("MANAGE_FORBIDDEN", "Removing people needs a channel admin");
      const ids = (memberIds.get(c.id) ?? []).filter((id) => id !== userId);
      memberIds.set(c.id, ids);
      c.memberCount = ids.length;
      if (userId === MOCK_ME.id) c.isMember = false;
      emitSummary();
    },

    async edit(messageId, text) {
      env.requireOn();
      const m = findMessage(messageId);
      if (!m) throw refuse("notFound", "No such message");
      if (!m.mine) throw refuse("forbidden", "You can only edit your own messages");
      const body = text.trim();
      if (!body) throw refuse("validation", "A message cannot be empty");
      m.text = body;
      m.edited = true;
      if (!m.threadRoot) updateLast(need(m.channelId));
      emitMessage(m, "updated");
      return copy(m);
    },
    async remove(channelId, messageId, threadRootId) {
      env.requireOn();
      need(channelId);
      const m = threadRootId ? replies.get(threadRootId)?.find((x) => x.id === messageId) : messages.get(channelId)?.find((x) => x.id === messageId);
      if (!m) throw refuse("notFound", "No such message");
      if (!m.mine) throw refuse("forbidden", "You can only delete your own messages");
      m.deleted = true;
      m.text = "";
      m.reactions = [];
      m.pinned = false;
      if (!m.threadRoot) updateLast(need(channelId));
      emitMessage(m, "deleted");
      emitSummary();
    },
    async react(messageId, emoji) {
      env.requireOn();
      const m = findMessage(messageId);
      if (!m) throw refuse("notFound", "No such message");
      const r = m.reactions.find((x) => x.emoji === emoji);
      if (!r) m.reactions.push({ emoji, count: 1, mine: true });
      else if (r.mine) {
        r.count -= 1;
        r.mine = false;
        if (r.count <= 0) m.reactions = m.reactions.filter((x) => x !== r);
      } else {
        r.count += 1;
        r.mine = true;
      }
      emitMessage(m, "updated");
      return copy(m);
    },
    async pin(messageId, pinned) {
      env.requireOn();
      const m = findMessage(messageId);
      if (!m) throw refuse("notFound", "No such message");
      m.pinned = pinned;
      emitMessage(m, "updated");
      return copy(m);
    },
    async search(query, channelId) {
      env.requireOn();
      const q = query.trim().toLowerCase();
      if (q.length < 2) return { messages: [], channels: [], people: [] };
      const hits: { message: ChatMessage; channelName: string }[] = [];
      const scan = (list: ChatMessage[]) => {
        for (const m of list) {
          const c = channels.get(m.channelId);
          if (c?.isMember && !m.deleted && (!channelId || m.channelId === channelId) && m.text.toLowerCase().includes(q)) hits.push({ message: copy(m), channelName: c.name });
        }
      };
      for (const list of messages.values()) scan(list);
      for (const list of replies.values()) scan(list);
      hits.sort((a, b) => b.message.createdAtMs - a.message.createdAtMs);
      return {
        messages: hits.slice(0, 20),
        channels: channelId ? [] : [...channels.values()].filter((c) => !isDirect(c) && c.name.toLowerCase().includes(q)).map(copy),
        people: channelId ? [] : PEOPLE.filter((p) => p.name.toLowerCase().includes(q)).map((p) => ({ ...p })),
      };
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  const senderOf = (from?: string) => PEOPLE.find((p) => p.id === from) ?? PEOPLE[0]!;
  const sim: MockChatSim = {
    receive(channelId, text, from) {
      need(channelId);
      const sender = senderOf(from);
      const m = msg({ id: `m_${channelId}_${++seq + 2000}`, channelId, senderId: sender.id, text, createdAtMs: now(), mentionsMe: text.includes(`@${MOCK_ME.name}`) });
      deliver(m, "new");
      return copy(m);
    },
    receiveReply(rootId, text, from) {
      const found = rootOf(rootId);
      if (!found) throw refuse("notFound", "No such thread");
      const sender = senderOf(from);
      const m = msg({ id: `r_${rootId}_${++seq + 2000}`, channelId: found.channel.id, senderId: sender.id, text, createdAtMs: now(), mentionsMe: text.includes(`@${MOCK_ME.name}`), threadRoot: rootId });
      deliver(m, "new");
      return copy(m);
    },
    markThreadUnread(rootId, n) {
      if (n > 0) threadUnread.set(rootId, n);
      else threadUnread.delete(rootId);
      if (n > 0 && openedThread === rootId) openedThread = undefined;
      emitSummary();
    },
    typing: (channelId, names) => emit({ type: "typing", channelId, names }),
    setLink(next) {
      link = next;
      emit({ type: "link", link });
      emitSummary();
    },
    setCredits(next) {
      credits = next;
      creditsEmpty = next <= 0;
      emitSummary();
    },
    setPermissions(p) {
      if (p.canCreateChannel !== undefined) canCreateChannel = p.canCreateChannel;
      if (p.canManageChannels !== undefined) canManageChannels = p.canManageChannels;
      emitSummary();
    },
    failNext: (code, message) => void (failure = { code, message: message ?? "Injected failure" }),
    setSendDelay: (ms) => void (sendDelay = ms),
    viewing: () => viewed,
    readCalls: () => [...reads],
  };

  return { api, sim, current: summary };
}
