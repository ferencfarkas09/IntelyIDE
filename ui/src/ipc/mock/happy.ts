import type { ConfigPatch, HappyConfig, HappyStatus, LastError, MeetView, ProjectHit, ProviderPrefs, ProviderState, TaskSearch, TimerView, Trackable, TimeEntry } from "../happy";
import type { HappyIpc } from "../happy";
import { chatScenarioFromUrl, createMockChat, type ChatScenario, type MockChatSim } from "./happyChat";
import { createMockNt, type MockNtSim } from "./happyNt";

export type { ChatScenario, MockChatSim } from "./happyChat";

const USER = { id: "u_1", name: "Teszt Elek", roles: ["admin", "timeTracker"], restaurantId: "r_1", restaurantName: "Demo Gastro" };

const TRACKABLES: Trackable[] = [
  { kind: "project", id: "p_pos", taskId: "t_receipts", title: "Receipts", project: "Shop POS" },
  { kind: "project", id: "p_pos", taskId: "t_refunds", title: "Refunds", project: "Shop POS" },
  { kind: "project", id: "p_admin", taskId: "t_l10n", title: "Localization", project: "Admin" },
  { kind: "workOrder", id: "w_till", title: "Fix the till printer" },
];

const PROJECTS: ProjectHit[] = [
  { id: "p_pos", title: "Shop POS", code: "HP", customer: "Acme Kft." },
  { id: "p_admin", title: "Admin", code: "ADM", customer: "Demo Gastro" },
  { id: "p_backend", title: "Happy Backend", code: "BE" },
];
const TASKS: Trackable[] = [
  { kind: "project", id: "p_pos", taskId: "t_receipts", title: "Receipts", project: "Shop POS" },
  { kind: "project", id: "p_pos", taskId: "t_refunds", title: "Refunds", project: "Shop POS" },
  { kind: "project", id: "p_admin", taskId: "t_l10n", title: "Localization", project: "Admin" },
  { kind: "project", id: "p_admin", taskId: "t_review", title: "Review the rounding fix", project: "Admin" },
  { kind: "project", id: "p_backend", taskId: "t_api", title: "Orders endpoint pagination", project: "Happy Backend" },
];

const MIN = 60_000;

export type HappyPreset = "off" | "connected";

export interface MockHappyOptions {
  preset?: HappyPreset;
  now?: () => number;
  /** What the mock chat looks like (default: `?chat=` in the URL, else `ok`). */
  chat?: ChatScenario;
  /** The mock secret store's key set: the token lives there as `happy.token.<env>`, like the real store's slot. */
  secretKeys?: Set<string>;
}

/** `?happy=connected` in the dev URL opens the mock already switched on, for screenshots. */
function presetFromUrl(): HappyPreset {
  return new URLSearchParams(globalThis.location?.search).get("happy") === "connected" ? "connected" : "off";
}

const idle = (): TimerView => ({ phase: "idle", kind: "", targetId: "", title: "", startedAtMs: 0, accumulatedSec: 0, canBreak: false, offsetMs: 0, stale: false });

/**
 * A deterministic in-memory Happy: the same error codes as the real thing (`notConnected`, `blocked`), no network. The token
 * is accepted when it has three dot-separated parts, like the real shape check.
 */
/** Test handle on the mock timer: change it "elsewhere" (the web admin or the phone) the way the poll would report it. */
export interface MockTimerSim {
  elsewhere(next: TimerView): TimerView;
}

export function createMockHappy(options: MockHappyOptions = {}): HappyIpc & { chatSim: MockChatSim; timerSim: MockTimerSim } {
  const now = options.now ?? Date.now;
  const scenario = options.chat ?? chatScenarioFromUrl();
  const connected = (options.preset ?? presetFromUrl()) === "connected";
  let config: HappyConfig & { chat: ProviderPrefs } = {
    master: connected,
    env: "sandbox",
    timer: { enabled: connected, showInStatusBar: true, allowActions: true },
    meet: { enabled: connected, showInStatusBar: true, allowActions: true },
    chat: { enabled: connected, showInStatusBar: true, allowActions: true },
    notifications: { enabled: connected, showInStatusBar: true, allowActions: true },
    tasks: { enabled: connected, showInStatusBar: true, allowActions: true },
  };
  const secretKeys = options.secretKeys ?? new Set<string>();
  const slot = () => `happy.token.${config.env}`;
  if (connected) secretKeys.add(slot());
  const tokenSaved = () => secretKeys.has(slot());
  let timer = idle();
  const tasks: Trackable[] = [...TASKS];
  const localDay = (ms: number, add = 0) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + add).getTime();
  };
  /** Settled rows of one local day, shaped like the real ones: the project (and its customer) is all a row says. Weekends are empty. */
  const dayRows = (day: number): TimeEntry[] => {
    const wd = new Date(day).getDay();
    const today = day === localDay(now());
    if (day > localDay(now())) return [];
    if (!today && (wd === 0 || wd === 6)) return [];
    const rows: TimeEntry[] = [
      { id: `e_${day}_1`, title: "Shop POS", project: "Acme Kft.", startedAtMs: day + 8 * 60 * MIN, endedAtMs: day + 9.5 * 60 * MIN, seconds: 5400, abandoned: false },
      { id: `e_${day}_2`, title: "Admin", project: "Demo Gastro", startedAtMs: day + 10 * 60 * MIN, endedAtMs: day + 10.75 * 60 * MIN, seconds: 2700, abandoned: false },
    ];
    if (today) rows.push({ id: `e_${day}_3`, title: "Forgotten timer", project: "Demo Gastro", startedAtMs: day + 11 * 60 * MIN, endedAtMs: day + 12 * 60 * MIN, seconds: 0, abandoned: true });
    return rows;
  };
  const stateListeners = new Set<(s: HappyStatus) => void>();
  const timerListeners = new Set<(t: TimerView) => void>();
  const meetListeners = new Set<(m: MeetView) => void>();
  let signedOut: LastError | undefined = connected && scenario === "signedout" ? { code: "DEVICE_LOGGED_OUT", message: "The session was revoked", atMs: now() } : undefined;

  const stateOf = (enabled: boolean, id = ""): ProviderState => {
    if (!config.master || !enabled) return "off";
    if (signedOut) return "signedOut";
    if (!tokenSaved()) return "waitingForToken";
    if (id === "chat" && (scenario === "forbidden" || scenario === "notenabled")) return "notPermitted";
    if (id === "chat" && scenario === "offline") return "degraded";
    return "ready";
  };
  const status = (): HappyStatus => ({
    config: structuredClone(config),
    baseUrl: config.env === "production" ? "https://happy.example.test" : config.env === "sandbox" ? "https://happy.example.test" : config.customBaseUrl,
    tokenSaved: tokenSaved(),
    user: tokenSaved() ? { ...USER } : undefined,
    validatedAtMs: tokenSaved() ? now() : undefined,
    signedOut,
    providers: [
      { id: "timer", state: stateOf(config.timer.enabled) },
      { id: "meet", state: stateOf(config.meet.enabled) },
      {
        id: "chat",
        state: stateOf(config.chat.enabled, "chat"),
        lastError: config.chat.enabled && scenario === "forbidden" && tokenSaved() ? { code: "forbidden_scope", message: "This account needs the chat.page.access permission", atMs: now() } : config.chat.enabled && scenario === "notenabled" && tokenSaved() ? { code: "TEAM_CHAT_NOT_ENABLED", message: "Team chat is not enabled for this store", atMs: now() } : undefined,
      },
      { id: "notifications", state: stateOf(config.notifications.enabled) },
      { id: "tasks", state: stateOf(config.tasks.enabled) },
    ],
  });
  const checks = () => [
    { id: "timer", allowed: true },
    { id: "meet", allowed: true },
    scenario === "forbidden" ? { id: "chat", allowed: false, hint: "needs chat.page.access" } : { id: "chat", allowed: true },
    { id: "notifications", allowed: true },
    { id: "tasks", allowed: true },
  ];
  const emitState = () => stateListeners.forEach((cb) => cb(status()));
  const setTimer = (next: TimerView): TimerView => {
    timer = next;
    timerListeners.forEach((cb) => cb({ ...next }));
    return { ...next };
  };
  const requireOn = (id: "timer" | "meet" | "chat" | "notifications" | "tasks") => {
    if (!config.master || !config[id].enabled || !tokenSaved()) throw { code: "notConnected", message: "Switch the integration on and save a token first" };
    if (signedOut) throw { code: "signedOut", message: signedOut.message };
    if (id === "chat" && scenario === "forbidden") throw { code: "forbidden", message: "This account needs the chat.page.access permission" };
    if (id === "chat" && scenario === "notenabled") throw { code: "TEAM_CHAT_NOT_ENABLED", message: "Team chat is not enabled for this store" };
  };
  const requireActions = (id: "timer" | "meet" | "notifications" | "tasks") => {
    requireOn(id);
    if (!config[id].allowActions) throw { code: "blocked", message: "Actions are switched off for this integration" };
  };
  const meetings = (): MeetView => ({
    stale: false,
    meetings: [
      { id: "m_live_1", title: "Reggeli standup", channel: "general", status: "live", startMs: now() - 10 * MIN, participants: 4, host: "Kovács Anna" },
      { id: "m_soon_1", title: "Sprint review", channel: "dev", status: "scheduled", startMs: now() + 10 * MIN, participants: 0, host: "Nagy Péter" },
      { id: "m_later_1", title: "Retro", channel: "dev", status: "scheduled", startMs: now() + 180 * MIN, participants: 0, host: "Nagy Péter" },
    ],
  });
  const chat = createMockChat({ now, scenario, requireOn: () => requireOn("chat") });
  const nt = createMockNt({
    now,
    on: (id) => config.master && config[id].enabled && tokenSaved() && !signedOut,
    requireOn,
    requireActions,
  });
  const openedLinks: string[] = [];
  const timerSim: MockTimerSim = { elsewhere: (next) => setTimer({ ...next }) };
  const g = globalThis as { __mockHappyChat?: MockChatSim; __mockHappyNt?: MockNtSim; __mockHappyTimer?: MockTimerSim; __mockOpened?: string[] };
  g.__mockHappyChat = chat.sim;
  g.__mockHappyNt = nt.sim;
  g.__mockHappyTimer = timerSim;
  g.__mockOpened = openedLinks;
  const accumulated = (): number => timer.accumulatedSec + (timer.phase === "running" ? Math.round((now() - timer.startedAtMs) / 1000) : 0);

  return {
    chatSim: chat.sim,
    timerSim,
    chat: chat.api,
    notifications: nt.inbox,
    tasks: nt.tasks,
    async openExternal(url) {
      if (!/^https:\/\/[^\s/]+/.test(url)) throw { code: "openFailed", message: "only https links can be opened" };
      openedLinks.push(url);
    },
    status: async () => status(),
    async setConfig(patch: ConfigPatch) {
      const next: HappyConfig & { chat: ProviderPrefs } = {
        ...config,
        master: patch.master ?? config.master,
        env: patch.env ?? config.env,
        customBaseUrl: patch.customBaseUrl == null ? config.customBaseUrl : patch.customBaseUrl.trim() || undefined,
        timer: { ...config.timer, ...clean(patch.timer) },
        meet: { ...config.meet, ...clean(patch.meet) },
        chat: { ...config.chat, ...clean(patch.chat) },
        notifications: { ...config.notifications, ...clean(patch.notifications) },
        tasks: { ...config.tasks, ...clean(patch.tasks) },
      };
      if (next.env === "custom" && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(next.customBaseUrl ?? "")) {
        throw { code: "invalidBaseUrl", message: "The base URL must be https (http is only allowed for localhost)" };
      }
      config = next;
      if (patch.env) {
        signedOut = undefined;
        timer = idle();
      }
      emitState();
      return status();
    },
    async saveToken(token) {
      if (token.trim().split(".").length !== 3) return { ok: false, message: "That does not look like a Happy login token (three parts separated by dots)", providers: [] };
      secretKeys.add(slot());
      signedOut = undefined;
      emitState();
      return { ok: true, user: { ...USER }, providers: checks() };
    },
    async testConnection() {
      if (!tokenSaved()) return { ok: false, message: "No token is saved for this environment", providers: [] };
      return { ok: true, user: { ...USER }, providers: checks() };
    },
    async disconnect() {
      secretKeys.delete(slot());
      timer = idle();
      emitState();
      return status();
    },
    onState(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    timer: {
      current: async () => ({ ...timer }),
      async start(target) {
        requireActions("timer");
        return setTimer({ phase: "running", kind: target.kind, targetId: target.id, taskId: target.taskId, title: target.title, project: target.project, startedAtMs: now(), accumulatedSec: 0, canBreak: false, offsetMs: 0, stale: false });
      },
      async stop() {
        requireActions("timer");
        return setTimer(idle());
      },
      async pause() {
        requireActions("timer");
        if (timer.phase !== "running") return setTimer(idle());
        return setTimer({ ...timer, phase: "paused", accumulatedSec: accumulated() });
      },
      async resume() {
        requireActions("timer");
        if (timer.phase !== "paused") return setTimer(idle());
        // Resuming opens a new entry on the server: the clock counts from zero again.
        return setTimer({ ...timer, phase: "running", startedAtMs: now(), accumulatedSec: 0 });
      },
      async trackables() {
        requireOn("timer");
        return structuredClone(TRACKABLES);
      },
      async entries(fromMs, toMs) {
        requireOn("timer");
        const rows: TimeEntry[] = [];
        for (let day = localDay(fromMs); day < toMs && rows.length < 5000; day = localDay(day, 1)) rows.push(...dayRows(day));
        if (timer.phase === "running" && timer.kind === "project" && timer.startedAtMs >= fromMs && timer.startedAtMs < toMs) {
          rows.push({ id: "e_run", title: timer.project ?? timer.title, project: "Acme Kft.", startedAtMs: timer.startedAtMs, endedAtMs: undefined, seconds: Math.max(0, Math.round((now() - timer.startedAtMs) / 1000)), abandoned: false });
        }
        const day = rows.filter((e) => e.startedAtMs >= fromMs && e.startedAtMs < toMs).sort((a, b) => b.startedAtMs - a.startedAtMs);
        return { entries: day, totalSeconds: day.reduce((n, e) => n + e.seconds, 0), truncated: false };
      },
      async totals(dayMs, weekMs, monthMs) {
        requireOn("timer");
        const sum = (from: number) => {
          let n = 0;
          for (let day = localDay(from); day <= now(); day = localDay(day, 1)) n += dayRows(day).reduce((s, e) => s + e.seconds, 0);
          return n;
        };
        return { daySec: sum(dayMs), weekSec: sum(weekMs), monthSec: sum(monthMs) };
      },
      async search(query): Promise<TaskSearch> {
        requireOn("timer");
        const q = query.trim().toLowerCase();
        if (!q) return { projects: [], tasks: [] };
        const projects = PROJECTS.filter((p) => `${p.title} ${p.code ?? ""} ${p.customer ?? ""}`.toLowerCase().includes(q)).slice(0, 6);
        const found = tasks.filter((x) => x.title.toLowerCase().includes(q) || projects.some((p) => p.id === x.id)).slice(0, 15);
        return structuredClone({ projects, tasks: found });
      },
      async createTask(projectId, title) {
        requireActions("timer");
        const project = PROJECTS.find((p) => p.id === projectId);
        if (!project) throw { code: "notFound", message: "Project not found" };
        if (!title.trim()) throw { code: "invalidTitle", message: "Give the task a title" };
        const created: Trackable = { kind: "project", id: project.id, taskId: `t_new${tasks.length}`, title: title.trim(), project: project.title };
        tasks.push(created);
        return { ...created };
      },
      onChange(cb) {
        timerListeners.add(cb);
        return () => timerListeners.delete(cb);
      },
    },
    meet: {
      async list() {
        requireOn("meet");
        return meetings();
      },
      current: async () => (config.master && config.meet.enabled && tokenSaved() ? meetings() : { meetings: [], stale: false }),
      async join(id) {
        requireActions("meet");
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw { code: "blocked", message: "That request is not on the allow-list" };
      },
      onChange(cb) {
        meetListeners.add(cb);
        return () => meetListeners.delete(cb);
      },
    },
  };
}

function clean<T extends object>(o: T | null | undefined): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null)) as { [K in keyof T]?: NonNullable<T[K]> };
}
