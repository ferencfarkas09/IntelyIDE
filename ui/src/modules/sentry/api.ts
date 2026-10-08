// Backend of the Sentry views: the `sentry_*` commands in the app, a deterministic fixture in a plain browser. Tests swap it with
// `setSentryApi`.
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { SentryConnection, SentryDetail, SentryEvent, SentryIssue, SentryPage, SentryProblem, SentryProject, SentryQuery, SentryStatus } from "./types";

export interface SentryApi {
  status(): Promise<SentryStatus>;
  setConfig(patch: { baseUrl?: string; org?: string }): Promise<SentryStatus>;
  saveToken(token: string): Promise<SentryConnection>;
  clearToken(): Promise<SentryStatus>;
  test(): Promise<SentryConnection>;
  projects(): Promise<SentryProject[]>;
  issues(query: SentryQuery): Promise<SentryPage>;
  issue(id: string): Promise<SentryDetail>;
  assignMe(id: string): Promise<SentryIssue>;
  setStatus(id: string, status: "resolved" | "unresolved" | "ignored"): Promise<SentryIssue>;
  openExternal(url: string): Promise<void>;
}

/** What a rejected command (an `EngineError`) says, as the view wants it. */
export function problemOf(e: unknown): SentryProblem {
  const x = (e ?? {}) as { code?: unknown; message?: unknown; detail?: unknown };
  const retry = typeof x.detail === "string" ? /retryAfterSeconds=(\d+)/.exec(x.detail)?.[1] : undefined;
  return { code: typeof x.code === "string" ? x.code : "unknown", message: typeof x.message === "string" ? x.message : String(e), ...(retry ? { retryAfterSeconds: Number(retry) } : {}) };
}

const tauriApi: SentryApi = {
  status: () => call("sentry_status", {}),
  setConfig: (p) => call("sentry_set_config", { baseUrl: p.baseUrl, org: p.org }),
  saveToken: (token) => call("sentry_save_token", { token }),
  clearToken: () => call("sentry_clear_token", {}),
  test: () => call("sentry_test", {}),
  projects: () => call("sentry_projects", {}),
  issues: (query) => call("sentry_issues", { query: { ...query, project: query.project ?? null, cursor: query.cursor ?? null, limit: query.limit ?? null } }),
  issue: (id) => call("sentry_issue", { id }),
  assignMe: (id) => call("sentry_assign_me", { id }),
  setStatus: (id, status) => call("sentry_set_status", { id, status }),
  openExternal: (url) => call("open_external", { url }),
};

let override: SentryApi | undefined;
export const setSentryApi = (api: SentryApi | undefined): void => void (override = api);

let mock: SentryApi | undefined;
export function sentryApi(): SentryApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockSentry());
}

// ---- the fixture -----------------------------------------------------------------------------------------------------

const H = 3_600_000;
const D = 24 * H;
const PROJECTS: SentryProject[] = [
  { id: "5", slug: "shop-backend", name: "Shop Backend" },
  { id: "6", slug: "shop-admin", name: "Shop Admin" },
  { id: "7", slug: "services-app", name: "Services App" },
];

interface Seed {
  title: string;
  culprit: string;
  level: string;
  project: number;
  count: number;
  users: number;
  firstDays: number;
  lastHours: number;
  type: string;
  value: string;
  status?: string;
  unhandled?: boolean;
  assigned?: string;
}

const SEEDS: Seed[] = [
  { title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: "src/api/orders.js in loadOrder", level: "error", project: 0, count: 412, users: 63, firstDays: 12, lastHours: 0.4, type: "TypeError", value: "Cannot read properties of undefined (reading 'id')", unhandled: true },
  { title: "MongoServerSelectionError: connection timed out", culprit: "src/lib/db.js in connect", level: "fatal", project: 0, count: 38, users: 0, firstDays: 3, lastHours: 2, type: "MongoServerSelectionError", value: "connection timed out after 30000 ms", unhandled: true },
  { title: "ValidationError: delivery fee must be a number", culprit: "src/api/controllers/orderController.js in createOrder", level: "warning", project: 0, count: 951, users: 120, firstDays: 40, lastHours: 1, type: "ValidationError", value: "delivery fee must be a number" },
  { title: "Error: Request failed with status code 502", culprit: "src/services/invoiceService.js in sendInvoice", level: "error", project: 0, count: 77, users: 21, firstDays: 6, lastHours: 9, type: "Error", value: "Request failed with status code 502", assigned: "Peter Kovacs" },
  { title: "RangeError: Invalid time value", culprit: "src/utils/dates.js in formatDay", level: "error", project: 0, count: 15, users: 4, firstDays: 20, lastHours: 70, type: "RangeError", value: "Invalid time value", status: "ignored" },
  { title: "TypeError: orders.map is not a function", culprit: "src/components/pages/orders/OrdersTable.tsx in OrdersTable", level: "error", project: 1, count: 203, users: 41, firstDays: 5, lastHours: 3, type: "TypeError", value: "orders.map is not a function", unhandled: true },
  { title: "ChunkLoadError: Loading chunk 14 failed", culprit: "webpack/runtime/load script", level: "error", project: 1, count: 560, users: 190, firstDays: 25, lastHours: 0.2, type: "ChunkLoadError", value: "Loading chunk 14 failed" },
  { title: "Warning: Each child in a list should have a unique key", culprit: "src/components/layout/Header.tsx in Header", level: "info", project: 1, count: 1204, users: 310, firstDays: 60, lastHours: 0.1, type: "Warning", value: "Each child in a list should have a unique key" },
  { title: "NetworkError: Failed to fetch", culprit: "app/services/api.ts in request", level: "error", project: 2, count: 330, users: 88, firstDays: 9, lastHours: 5, type: "NetworkError", value: "Failed to fetch", unhandled: true },
  { title: "Invariant Violation: Native module cannot be null", culprit: "app/screens/Booking.tsx in onMount", level: "fatal", project: 2, count: 19, users: 17, firstDays: 2, lastHours: 20, type: "Invariant Violation", value: "Native module cannot be null", unhandled: true },
  { title: "AuthError: google sign-in cancelled", culprit: "app/auth/google.ts in signIn", level: "warning", project: 2, count: 48, users: 33, firstDays: 14, lastHours: 30, type: "AuthError", value: "google sign-in cancelled", status: "resolved" },
  { title: "TypeError: undefined is not an object (evaluating 'service.price')", culprit: "app/screens/ServiceList.tsx in renderItem", level: "error", project: 2, count: 91, users: 29, firstDays: 11, lastHours: 7, type: "TypeError", value: "undefined is not an object (evaluating 'service.price')" },
];

/** The issues of the fixture: 36 of them (the 12 seeds three times, with other numbers), newest first. */
function buildIssues(now: number): SentryIssue[] {
  return Array.from({ length: SEEDS.length * 3 }, (_, i) => {
    const s = SEEDS[i % SEEDS.length];
    const wave = Math.floor(i / SEEDS.length);
    const project = PROJECTS[s.project];
    const id = String(48_100 + i);
    const status = wave === 0 ? (s.status ?? "unresolved") : wave === 1 ? "unresolved" : i % 4 === 0 ? "resolved" : "unresolved";
    return {
      id,
      shortId: `${project.slug.toUpperCase().replace(/-/g, "")}-${(i + 10).toString(36).toUpperCase()}`,
      title: wave === 0 ? s.title : `${s.title} (${wave === 1 ? "checkout" : "retry"})`,
      culprit: s.culprit,
      level: s.level,
      status,
      count: Math.max(1, Math.round(s.count * (1 - wave * 0.3))),
      userCount: Math.max(0, Math.round(s.users * (1 - wave * 0.25))),
      firstSeen: new Date(now - (s.firstDays + wave * 4) * D).toISOString(),
      lastSeen: new Date(now - (s.lastHours + wave * 11) * H).toISOString(),
      permalink: `https://sentry.io/organizations/acme/issues/${id}/`,
      project,
      assignedTo: s.assigned && wave === 0 ? { kind: "user", id: "77", name: s.assigned } : null,
      errorType: s.type,
      errorValue: s.value,
      isUnhandled: !!s.unhandled,
    };
  }).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function eventFor(issue: SentryIssue): SentryEvent {
  const file = issue.culprit.split(" in ")[0] || "src/app.js";
  const fn = issue.culprit.split(" in ")[1] || "handler";
  return {
    eventId: `ev${issue.id}`,
    dateCreated: issue.lastSeen,
    platform: "node",
    release: "shop@2026.10.3",
    environment: "production",
    message: issue.errorValue ?? issue.title,
    exceptions: [
      {
        kind: issue.errorType ?? "Error",
        value: issue.errorValue ?? issue.title,
        frames: [
          { filename: "node_modules/express/lib/router/layer.js", function: "handle", line: 95, inApp: false, context: [] },
          { filename: "src/api/middleware/auth.js", function: "requireUser", line: 31, inApp: true, context: [{ line: 30, code: "const user = await users.find(token);" }, { line: 31, code: "req.user = user;" }, { line: 32, code: "next();" }] },
          { filename: file, function: fn, line: 42, inApp: true, context: [{ line: 41, code: "const order = await db.orders.findOne({ _id: id });" }, { line: 42, code: "return order.id;" }, { line: 43, code: "}" }] },
        ],
      },
    ],
    breadcrumbs: [
      { timestamp: issue.lastSeen, category: "http", message: "GET /api/orders/7", level: "info" },
      { timestamp: issue.lastSeen, category: "query", message: "db.orders.findOne", level: "info" },
    ],
    tags: [
      { key: "environment", value: "production" },
      { key: "browser", value: "Safari 18.1" },
      { key: "os", value: "macOS 15" },
      { key: "release", value: "shop@2026.10.3" },
    ],
    requestUrl: "https://shop.example.invalid/api/orders/7",
  };
}

const PERIOD_MS: Record<string, number> = { "24h": D, "7d": 7 * D, "14d": 14 * D, "30d": 30 * D, "90d": 90 * D };

/** A Sentry with a few dozen issues. Filters work like the server's for the parts the view uses: status, period, project, sort, words, `level:`. */
export function createMockSentry(now: number = Date.now()): SentryApi {
  let all = buildIssues(now);
  let status: SentryStatus = { baseUrl: "https://sentry.io", org: "acme", hasToken: true, configured: true };
  const find = (id: string) => {
    const i = all.find((x) => x.id === id);
    if (!i) throw { code: "notFound", message: "Sentry has no such organization, project or issue" };
    return i;
  };
  const patch = (id: string, change: Partial<SentryIssue>): SentryIssue => {
    const next = { ...find(id), ...change };
    all = all.map((x) => (x.id === id ? next : x));
    return structuredClone(next);
  };
  return {
    async status() {
      return { ...status };
    },
    async setConfig(p) {
      const before = status.baseUrl.replace(/\/+$/, "").toLowerCase();
      status = { ...status, ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl || "https://sentry.io" } : {}), ...(p.org !== undefined ? { org: p.org } : {}) };
      // like the app: a token belongs to the address it was entered for
      if (status.baseUrl.replace(/\/+$/, "").toLowerCase() !== before) status.hasToken = false;
      status.configured = status.hasToken && status.org !== "";
      return { ...status };
    },
    async saveToken(token) {
      if (!token.trim()) return { ok: false, orgName: null, user: null, problem: { code: "badRequest", message: "The token is empty" } };
      status = { ...status, hasToken: true, configured: status.org !== "" };
      return { ok: true, orgName: "Acme Inc", user: "Ferenc Farkas", problem: null };
    },
    async clearToken() {
      status = { ...status, hasToken: false, configured: false };
      return { ...status };
    },
    async test() {
      return status.configured ? { ok: true, orgName: "Acme Inc", user: "Ferenc Farkas", problem: null } : { ok: false, orgName: null, user: null, problem: { code: "notConfigured", message: "Add a Sentry token in Settings > Integrations first" } };
    },
    async projects() {
      return structuredClone(PROJECTS);
    },
    async issues(q) {
      const words = q.query.toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
      const level = /(?:^|\s)level:(\w+)/.exec(q.query)?.[1];
      const since = now - (PERIOD_MS[q.period] ?? 14 * D);
      let list = all.filter((i) => (q.status === "all" || i.status === q.status) && Date.parse(i.lastSeen) >= since && (!q.project || i.project?.id === q.project) && (!level || i.level === level));
      list = list.filter((i) => words.every((w) => `${i.title} ${i.culprit} ${i.shortId} ${i.errorValue ?? ""}`.toLowerCase().includes(w)));
      const by: Record<string, (a: SentryIssue, b: SentryIssue) => number> = {
        date: (a, b) => b.lastSeen.localeCompare(a.lastSeen),
        freq: (a, b) => b.count - a.count,
        new: (a, b) => b.firstSeen.localeCompare(a.firstSeen),
        user: (a, b) => b.userCount - a.userCount,
      };
      list = [...list].sort(by[q.sort] ?? by.date);
      const start = Number(/^0:(\d+):0$/.exec(q.cursor ?? "")?.[1] ?? 0);
      const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
      const page = list.slice(start, start + limit);
      return { issues: structuredClone(page), nextCursor: start + limit < list.length ? `0:${start + limit}:0` : null };
    },
    async issue(id) {
      const issue = find(id);
      return { issue: structuredClone(issue), event: eventFor(issue) };
    },
    async assignMe(id) {
      return patch(id, { assignedTo: { kind: "user", id: "42", name: "Ferenc Farkas" } });
    },
    async setStatus(id, next) {
      return patch(id, { status: next });
    },
    async openExternal() {},
  };
}
