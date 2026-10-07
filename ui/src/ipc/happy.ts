import type { ConfigPatch, ConnectionTest, HappyStatus, MeetView, TaskSearch, TimerView, TimeTotals, TodayView, Trackable } from "../bindings/happy";
import { createTauriChat, type HappyChatIpc } from "./happyChat";
import { createTauriInbox, createTauriTasks, type HappyInboxIpc, type HappyTasksIpc } from "./happyNt";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type * from "./happyChat";
export type { HappyChatIpc } from "./happyChat";
export type * from "./happyNt";

export type {
  ConfigPatch,
  ConnectionTest,
  Env,
  HappyConfig,
  HappyStatus,
  LastError,
  Meeting,
  MeetingStatus,
  MeetView,
  PrefsPatch,
  ProviderCheck,
  ProviderPrefs,
  ProviderState,
  ProviderStatus,
  ProjectHit,
  TaskSearch,
  TimeEntry,
  TimerPhase,
  TimerView,
  TimeTotals,
  TodayView,
  Trackable,
  UserInfo,
} from "../bindings/happy";

/**
 * Happy integrations ((design notes: integrations-plan)). All traffic runs in Rust: the webview sends a token once (`saveToken`),
 * never gets it back, and never sees raw Happy JSON or join links. Rejections are `EngineError`s: `notConnected`,
 * `blocked`, `signedOut`, `insufficientCredits`, `invalidBaseUrl`, ... or the server's own code (`INSUFFICIENT_CREDITS`).
 */
export interface HappyIpc {
  /** Config, connection and per-provider state. Asks the Keychain whether a token is saved, so call it when Settings opens. */
  status(): Promise<HappyStatus>;
  setConfig(patch: ConfigPatch): Promise<HappyStatus>;
  /** Validates with `GET /api/user/me` and saves only on success; the result says why not. */
  saveToken(token: string): Promise<ConnectionTest>;
  testConnection(): Promise<ConnectionTest>;
  /** Removes the saved token of the current environment and stops everything. */
  disconnect(): Promise<HappyStatus>;
  onState(cb: (s: HappyStatus) => void): Unsubscribe;
  timer: {
    /** The last known state (kept fresh by polling while the window is focused). */
    current(): Promise<TimerView>;
    start(target: Trackable): Promise<TimerView>;
    stop(): Promise<TimerView>;
    pause(): Promise<TimerView>;
    resume(): Promise<TimerView>;
    trackables(): Promise<Trackable[]>;
    /** Entries between two instants (epoch ms), newest first; windows over 500 rows are paged in Rust (`truncated` past the cap). */
    entries(fromMs: number, toMs: number): Promise<TodayView>;
    /** Settled seconds of the day, week and month that start at the given instants (the running entry is not in them). */
    totals(dayMs: number, weekMs: number, monthMs: number): Promise<TimeTotals>;
    /** Server-side search over projects (name, code, customer) and tasks (title, code); tasks come with their project's title. */
    search(query: string): Promise<TaskSearch>;
    /** Creates a task in a project and returns it as a start target. Rejects `rejected` (400), `forbidden`, `notFound`, `blocked`. */
    createTask(projectId: string, title: string): Promise<Trackable>;
    onChange(cb: (t: TimerView) => void): Unsubscribe;
  };
  meet: {
    /** Fetches live and scheduled meetings now. */
    list(): Promise<MeetView>;
    current(): Promise<MeetView>;
    /** Fetches a fresh join link and opens it in the system browser; the link never reaches the webview. */
    join(id: string): Promise<void>;
    onChange(cb: (m: MeetView) => void): Unsubscribe;
  };
  /** Team chat (Beta 2). Rust owns the cache and the socket; the webview applies the deltas of `onEvent`. */
  chat: HappyChatIpc;
  /** Notifications inbox (Beta 2, plan E3). */
  notifications: HappyInboxIpc;
  /** My tasks (Beta 2, plan E4). */
  tasks: HappyTasksIpc;
  /** Opens an https link in the system browser (anything else is refused in Rust; the URL is never logged). */
  openExternal(url: string): Promise<void>;
}

export function createTauriHappy(): HappyIpc {
  return {
    status: () => call("happy_status"),
    setConfig: (patch) => call("happy_set_config", { patch }),
    saveToken: (token) => call("happy_save_token", { token }),
    testConnection: () => call("happy_test_connection"),
    disconnect: () => call("happy_disconnect"),
    onState: (cb) => subscribe("happy:state", cb),
    timer: {
      current: () => call("happy_timer_current"),
      start: (target) => call("happy_timer_start", { target }),
      stop: () => call("happy_timer_stop"),
      pause: () => call("happy_timer_pause"),
      resume: () => call("happy_timer_resume"),
      trackables: () => call("happy_timer_trackables"),
      entries: (fromMs, toMs) => call("happy_timer_entries", { fromMs, toMs }),
      totals: (dayMs, weekMs, monthMs) => call("happy_timer_totals", { dayMs, weekMs, monthMs }),
      search: (query) => call("happy_timer_search", { query }),
      createTask: (projectId, title) => call("happy_timer_create_task", { projectId, title }),
      onChange: (cb) => subscribe("happy:timer", cb),
    },
    meet: {
      list: () => call("happy_meet_list"),
      current: () => call("happy_meet_current"),
      join: (id) => call("happy_meet_join", { id }),
      onChange: (cb) => subscribe("happy:meetings", cb),
    },
    chat: createTauriChat(),
    notifications: createTauriInbox(),
    tasks: createTauriTasks(),
    openExternal: (url) => call("open_external", { url }),
  };
}
