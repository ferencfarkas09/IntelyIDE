import type {
  Change,
  ChangeKind,
  ChangedFile,
  CommitInfo,
  CommitRequest,
  EngineError,
  EngineStatus,
  EnvStatus,
  FileContents,
  GuardState,
  Hunk,
  OpEvent,
  OpKind,
  OpResult,
  OutgoingInfo,
  PushFlag,
  PushRequest,
  RepoConfig,
  RepoOutcome,
  RepoSnapshot,
  RepoState,
  RunStarted,
  UntrackedList,
  Workspace,
} from "../bindings";
import type { Ipc, Unsubscribe } from "./index";
import { createMockAgents } from "./mock-agent";
import { mockRunsCode } from "./mock/execSurface";
import { SHOWCASE_AUTHOR, SHOWCASE_ROOT } from "./mock/showcase";
import { createMockNamespaces } from "./namespaces";
import { createMockWorkspaces, type MockWorkspaces } from "./mock/workspaces";

export interface MockOptions {
  /** Multiplier for the simulated latencies; 0 makes every step resolve on the next macrotask. */
  delayScale?: number;
  /** Keep the mock workspace registry in localStorage so it survives the reload that follows a switch (the browser singleton). */
  persistRegistry?: boolean;
  /** A ready-made registry (tests that drive both the registry and the engine). */
  workspaces?: MockWorkspaces;
}

interface MockRepo {
  config: RepoConfig;
  branch: string;
  upstream: string;
  behind: number;
  changes: Change[];
  /** Files below each collapsed untracked directory. */
  untracked: Record<string, string[]>;
  outgoing: CommitInfo[];
  hooksFail?: boolean;
  stashCount?: number;
  worktreeCount?: number;
  state?: RepoState;
  /** The snapshot carries this error and no changes. */
  error?: string;
  /** Pushes are rejected as non-fast-forward. */
  pushRejected?: boolean;
  /** The next commit attempt fails with lockBusy, later ones succeed. */
  lockBusyOnce?: boolean;
}

const SCENARIOS = ["normal", "big", "failures", "empty", "merging", "exec-surface", "showcase", "showcase-welcome"] as const;
export type MockScenario = (typeof SCENARIOS)[number];

const KIND_LETTER: Record<ChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "?",
  conflicted: "U",
  submodule: "M",
};

const GUARDED: [RegExp, GuardState][] = [
  [/(^|\/)\.env(\..*)?$|google-services\.json$/, "secret"],
  [/(^|\/)\.npmrc$/, "sensitive"],
  [/(^|\/)(dump_|SERVER_MOVE|_to_delete|_check_|_tmp_|backup_|\.history|crm-export)/, "neverAdd"],
];

function change(path: string, kind: ChangeKind, o: { staged?: boolean; orig?: string; dir?: boolean; size?: number } = {}): Change {
  const untracked = kind === "untracked";
  const letter = KIND_LETTER[kind];
  const staged = o.staged ?? false;
  return {
    path,
    origPath: o.orig,
    kind,
    indexStatus: staged ? letter : untracked ? "?" : " ",
    worktreeStatus: staged ? " " : letter,
    staged,
    partiallyStaged: false,
    guard: GUARDED.find(([re]) => re.test(path))?.[1] ?? "ok",
    sizeBytes: o.size,
    dir: o.dir || undefined,
  };
}

function commitInfo(oid: string, subject: string, author: string, ageMin: number): CommitInfo {
  return { oid, shortOid: oid.slice(0, 7), subject, author, dateMs: Date.now() - ageMin * 60_000 };
}

function repoConfig(id: string, path: string, name: string, color: string, badge: string, order: number): RepoConfig {
  return { id, path, name, color, badge, order, pushTargets: {} };
}

function localizationFiles(): string[] {
  const keys = ["tiers", "rewards", "points", "history", "settings", "banner"];
  return ["hu", "en", "de"].flatMap((lang) => keys.map((k) => `src/localization/modules/loyalty/${lang}/${k}.json`));
}

function normalRepos(): MockRepo[] {
  const backend: MockRepo = {
    config: repoConfig("backend", "/Users/example/Projects/shop-backend", "shop-backend", "#4caf7d", "HB", 0),
    branch: "sandbox",
    upstream: "origin/sandbox",
    behind: 0,
    changes: [
      change("src/api/controllers/orderController.js", "modified"),
      change("src/api/services/invoiceService.js", "modified"),
      change("src/api/services/loyaltyService.js", "added", { staged: true }),
      change("src/api/routes/index.js", "modified"),
      change("src/api/swagger/orders.json", "modified"),
      change("src/api/utils/legacyExport.js", "deleted"),
      change("src/api/migrations/20261001_add_loyalty.js", "untracked", { size: 2_140 }),
      change(".env", "untracked", { size: 612 }),
      change("dump_2026-09-30/", "untracked", { dir: true }),
    ],
    untracked: { "dump_2026-09-30/": ["dump_2026-09-30/orders.json", "dump_2026-09-30/users.json"] },
    outgoing: [commitInfo("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "Add loyalty points accrual to order close", "Ferenc Farkas", 95)],
    hooksFail: false,
    stashCount: 2,
  };
  const admin: MockRepo = {
    config: {
      ...repoConfig("admin", "/Users/example/Projects/admin", "admin", "#8b6cf0", "AD", 1),
      pushTargets: { "feature-light-design": { remote: "origin", branch: "sandbox" } },
    },
    branch: "feature-light-design",
    upstream: "origin/feature-light-design",
    behind: 0,
    changes: [
      change("src/components/modules/orders/OrdersTable.tsx", "modified"),
      change("src/theme/light.css", "modified"),
      change("src/components/pages/dashboard/Dashboard.tsx", "modified"),
      change("src/components/layout/Header.tsx", "renamed", { staged: true, orig: "src/components/layout/Header.jsx" }),
      change("src/localization/modules/loyalty/", "untracked", { dir: true }),
      change("src/components/pages/loyalty/", "untracked", { dir: true }),
      change("docs/light-design.md", "untracked", { size: 3_900 }),
      change("src/theme/tokens.ts", "untracked", { size: 1_280 }),
    ],
    untracked: {
      "src/localization/modules/loyalty/": localizationFiles(),
      "src/components/pages/loyalty/": ["LoyaltyPage.tsx", "TierCard.tsx", "RewardList.tsx", "loyalty.css", "index.ts", "types.ts"].map(
        (f) => `src/components/pages/loyalty/${f}`,
      ),
    },
    outgoing: [commitInfo("b2c3d4e5f60718293a4b5c6d7e8f9012345678a1", "Light design: orders table and header", "Ferenc Farkas", 240)],
    worktreeCount: 1,
  };
  const services: MockRepo = {
    config: repoConfig("services", "/Users/example/Projects/shop-mobile", "shop-mobile", "#f0a23a", "SV", 2),
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    changes: [
      change("app/(tabs)/index.tsx", "modified"),
      change("app/components/BookingCard.tsx", "modified"),
      change("locales/hu.json", "modified"),
      change("locales/en.json", "modified"),
      change("android/app/google-services.json", "modified"),
      change(".npmrc", "modified"),
    ],
    untracked: {},
    outgoing: [],
  };
  const pos: MockRepo = {
    config: repoConfig("pos", "/Users/example/Projects/shop-pos", "shop-pos", "#3b9ae8", "HP", 3),
    branch: "SHOP-260",
    upstream: "origin/SHOP-260",
    behind: 2,
    changes: [
      change("src/pos/Cart.js", "modified"),
      change("src/pos/PaymentDialog.js", "modified"),
      change("src-tauri/src/printer.rs", "modified"),
      change("src/pos/receipt.js", "added", { staged: true }),
      change("src/pos/receipt.test.js", "untracked", { size: 1_730 }),
    ],
    untracked: {},
    outgoing: [],
  };
  return [backend, admin, services, pos];
}

/** Deterministic pseudo-random numbers so the `big` scenario is identical on every load. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The admin repo with exactly 5,000 changes: tracked files, plain untracked files and collapsed untracked folders. */
function bigAdmin(base: MockRepo): MockRepo {
  const rnd = seeded(2610);
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  const areas = ["orders", "invoices", "customers", "loyalty", "inventory", "reports", "settings", "booking", "payments", "staff"];
  const kinds = ["Table", "Form", "Filters", "Chart", "Dialog", "Header", "Sidebar", "Toolbar", "Row", "Card"];
  const exts = ["tsx", "tsx", "tsx", "ts", "css", "json"];
  const tracked: Change[] = [];
  const seen = new Set<string>();
  while (tracked.length < 4_500) {
    const area = pick(areas);
    const name = `${pick(kinds)}${Math.floor(rnd() * 400)}`;
    const ext = pick(exts);
    const path = ext === "json" ? `src/localization/modules/${area}/${pick(["hu", "en", "de"])}/${name}.json` : `src/components/modules/${area}/${name}.${ext}`;
    if (seen.has(path)) continue;
    seen.add(path);
    const roll = rnd();
    tracked.push(
      roll < 0.74
        ? change(path, "modified")
        : roll < 0.84
          ? change(path, "added", { staged: true })
          : roll < 0.94
            ? change(path, "deleted")
            : change(path, "renamed", { staged: rnd() < 0.5, orig: path.replace(/\.(tsx|ts|css|json)$/, ".old.$1") }),
    );
  }
  const plain: Change[] = [change(".env.production", "untracked", { size: 480 })];
  for (let i = 0; plain.length < 440; i++) plain.push(change(`docs/notes/draft-${String(i).padStart(3, "0")}.md`, "untracked", { size: 1_000 + i }));
  const dirs: Change[] = [];
  const untracked: Record<string, string[]> = {};
  for (let d = 0; d < 60; d++) {
    const dir = `src/generated/batch-${String(d).padStart(2, "0")}/`;
    dirs.push(change(dir, "untracked", { dir: true }));
    untracked[dir] = Array.from({ length: 20 }, (_, i) => `${dir}chunk-${String(i).padStart(2, "0")}.json`);
  }
  return { ...base, changes: [...tracked, ...plain, ...dirs], untracked };
}

function mergingRepo(base: MockRepo): MockRepo {
  return {
    ...base,
    state: "merging",
    changes: [
      change("app/(tabs)/index.tsx", "conflicted"),
      change("locales/hu.json", "conflicted"),
      change("app/components/BookingCard.tsx", "modified", { staged: true }),
      change("app/components/SlotPicker.tsx", "added", { staged: true }),
      change("package.json", "modified", { staged: true }),
    ],
  };
}

/** The `showcase` scenario: four fictional repositories of the "Acme Shop" demo workspace (ids stay backend/admin/services/pos). */
function showcaseRepos(): MockRepo[] {
  const A = SHOWCASE_AUTHOR;
  const backend: MockRepo = {
    config: repoConfig("backend", `${SHOWCASE_ROOT}/orders-api`, "orders-api", "#4caf7d", "OA", 0),
    branch: "feature/loyalty-points",
    upstream: "origin/feature/loyalty-points",
    behind: 0,
    changes: [
      change("src/api/controllers/orderController.js", "modified"),
      change("src/api/services/invoiceService.js", "modified"),
      change("src/api/services/loyaltyService.js", "added", { staged: true }),
      change("src/api/routes/index.js", "modified"),
      change("src/api/swagger/orders.json", "modified"),
      change("src/api/utils/legacyExport.js", "deleted"),
      change("src/api/migrations/20261001_add_loyalty.js", "untracked", { size: 2_140 }),
      change(".env", "untracked", { size: 612 }),
    ],
    untracked: {},
    outgoing: [
      commitInfo("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "Accrue loyalty points when an order is closed", A, 95),
      commitInfo("c3d4e5f60718293a4b5c6d7e8f901234567a1b2", "Add points ledger and idempotent accrual", A, 210),
    ],
    hooksFail: false,
    stashCount: 1,
  };
  const admin: MockRepo = {
    config: {
      ...repoConfig("admin", `${SHOWCASE_ROOT}/storefront-admin`, "storefront-admin", "#8b6cf0", "SA", 1),
      pushTargets: { "feat/dark-dashboard": { remote: "origin", branch: "feat/dark-dashboard" } },
    },
    branch: "feat/dark-dashboard",
    upstream: "origin/feat/dark-dashboard",
    behind: 0,
    changes: [
      change("src/components/modules/orders/OrdersTable.tsx", "modified"),
      change("src/theme/dark.css", "modified"),
      change("src/components/pages/dashboard/Dashboard.tsx", "modified"),
      change("src/components/layout/Header.tsx", "renamed", { staged: true, orig: "src/components/layout/Header.jsx" }),
      change("src/components/pages/loyalty/", "untracked", { dir: true }),
      change("docs/dark-theme.md", "untracked", { size: 3_900 }),
      change("src/theme/tokens.json", "untracked", { size: 1_280 }),
    ],
    untracked: {
      "src/components/pages/loyalty/": ["LoyaltyPage.tsx", "TierCard.tsx", "RewardList.tsx", "loyalty.css", "index.ts", "types.ts"].map((f) => `src/components/pages/loyalty/${f}`),
    },
    outgoing: [commitInfo("b2c3d4e5f60718293a4b5c6d7e8f9012345678a1", "Dark theme: orders table and header", A, 240)],
    worktreeCount: 1,
  };
  const services: MockRepo = {
    config: repoConfig("services", `${SHOWCASE_ROOT}/mobile-app`, "mobile-app", "#f0a23a", "MA", 2),
    branch: "feat/booking-slots",
    upstream: "origin/feat/booking-slots",
    behind: 0,
    changes: [
      change("app/(tabs)/index.tsx", "modified"),
      change("app/components/BookingCard.tsx", "modified"),
      change("locales/en.json", "modified"),
      change("locales/de.json", "modified"),
    ],
    untracked: {},
    outgoing: [],
  };
  const pos: MockRepo = {
    config: repoConfig("pos", `${SHOWCASE_ROOT}/pos-desktop`, "pos-desktop", "#3b9ae8", "PD", 3),
    branch: "fix/receipt-rounding",
    upstream: "origin/fix/receipt-rounding",
    behind: 1,
    changes: [
      change("src/pos/Cart.js", "modified"),
      change("src/pos/PaymentDialog.js", "modified"),
      change("src-tauri/src/printer.rs", "modified"),
      change("src/pos/receipt.js", "added", { staged: true }),
      change("src/pos/receipt.test.js", "untracked", { size: 1_730 }),
    ],
    untracked: {},
    outgoing: [commitInfo("d4e5f60718293a4b5c6d7e8f9012345678a1b2c3", "Round receipt totals to the currency minor unit", A, 40)],
  };
  return [backend, admin, services, pos];
}

function scenarioRepos(scenario: string): MockRepo[] {
  const repos = normalRepos();
  const byId = (id: string): MockRepo => repos.find((r) => r.config.id === id)!;
  switch (scenario) {
    case "big":
      return repos.map((r) => (r.config.id === "admin" ? bigAdmin(r) : r));
    case "failures":
      byId("backend").hooksFail = true;
      byId("admin").pushRejected = true;
      byId("services").lockBusyOnce = true;
      Object.assign(byId("pos"), { changes: [], untracked: {}, error: "Could not read the repository status: .git/index is locked by another process." });
      return repos;
    case "empty":
      return repos.map((r) => ({ ...r, changes: [], untracked: {}, outgoing: [], behind: 0, stashCount: 0, worktreeCount: 0 }));
    case "merging":
      return repos.map((r) => (r.config.id === "services" ? mergingRepo(r) : r));
    case "showcase":
    case "showcase-welcome":
      return showcaseRepos();
    case "exec-surface":
      // Files that run code at commit time, ticked next to ordinary sources (the Commit panel warning).
      byId("backend").changes.push(change(".husky/pre-commit", "modified"), change("package.json", "modified"));
      byId("services").changes.push(change("vite.config.ts", "modified"), change(".github/workflows/ci.yml", "added", { staged: true }));
      return repos;
    default:
      return repos;
  }
}

function safeStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return globalThis[kind] ?? null;
  } catch {
    return null;
  }
}

/** A repo the scenario does not know (a workspace created in the browser mock): clean apart from one edited file. */
function stubRepo(config: RepoConfig): MockRepo {
  return { config, branch: "main", upstream: "origin/main", behind: 0, changes: [change("README.md", "modified")], untracked: {}, outgoing: [] };
}

function workspaceFor(repos: MockRepo[]): Workspace {
  return {
    version: 1,
    repos: repos.map((r) => r.config),
    protectedBranches: ["main", "master", "production", "release/*"],
    settings: { messageMode: "shared", untrackedChecked: false },
  };
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

function engineError(code: string, message: string): EngineError {
  return { code, message };
}

/** Small per-language snippets, so the browser mock shows real syntax highlighting. */
const SNIPPETS: Record<string, { head: string[]; original: string[]; modified: string[]; tail: string[] }> = {
  css: {
    head: [".order-table {", "  display: grid;"],
    original: ["  color: #1a1c21;"],
    modified: ["  color: var(--text-1, #1a1c21);", "  border: 1px solid rgb(16 20 32 / 0.12); /* hairline */"],
    tail: ["}", "", "@media (max-width: 960px) { .order-table { gap: 4px; } }"],
  },
  json: {
    head: ["{", '  "name": "orders",'],
    original: ['  "version": "1.4.0",'],
    modified: ['  "version": "1.5.0",', '  "private": true,', '  "limits": { "maxItems": 250, "ratio": 0.75, "legacy": null },'],
    tail: ['  "tags": ["pos", "billing"]', "}"],
  },
  tsx: {
    head: ['import { For, Show } from "solid-js";', "", "interface Props { rows: Order[]; loading?: boolean }", ""],
    original: ["export function OrdersTable(props: Props) {", "  return <table>{props.rows.length}</table>;"],
    modified: ["export function OrdersTable(props: Props) {", '  const total = () => props.rows.reduce((n, r) => n + r.amount, 0);', "  return (", '    <Show when={!props.loading} fallback={<p class="muted">Loading…</p>}>', "      <table>{total()}</table>", "    </Show>", "  );"],
    tail: ["}"],
  },
  rs: {
    head: ["use std::collections::HashMap;", "", "pub fn total(items: &[Item]) -> u64 {", "    let mut sum = 0u64;"],
    original: ["    for it in items { sum += it.price; }"],
    modified: ["    for it in items {", '        sum += it.price * it.qty.unwrap_or(1) as u64; // "qty" is optional', "    }"],
    tail: ["    sum", "}"],
  },
  yml: {
    head: ["name: ci", "on: [push]", "jobs:", "  test:"],
    original: ["    runs-on: ubuntu-22.04"],
    modified: ["    runs-on: ubuntu-24.04", "    env: { NODE_ENV: test, RETRIES: 3 }"],
    tail: ["    steps:", "      - uses: actions/checkout@v4", '      - run: pnpm test # "fast"'],
  },
  env: {
    head: ["# local settings (mock values)", "PORT=3000"],
    original: ["API_KEY=mock-key-old"],
    modified: ["API_KEY=mock-key-new", "DEBUG=false"],
    tail: ["LOG_LEVEL=info"],
  },
  sh: {
    head: ["#!/usr/bin/env bash", "set -euo pipefail"],
    original: ['echo "building"'],
    modified: ['echo "building $(git rev-parse --short HEAD)"', 'if [ -n "${CI:-}" ]; then pnpm build --silent; fi'],
    tail: ['export DIST="$PWD/dist"'],
  },
};

const sample = (path: string, variant: "original" | "modified"): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const snippet = SNIPPETS[ext === "yaml" ? "yml" : ext === "bash" ? "sh" : ext];
  if (snippet) return [snippet.head.join("\n"), ...snippet[variant], ...snippet.tail, ""].join("\n");
  const head = [`// ${path}`, "", "export function total(items) {", "  let sum = 0;"];
  const body =
    variant === "original"
      ? ["  for (const it of items) sum += it.price;"]
      : ["  for (const it of items) {", "    sum += it.price * (it.qty ?? 1);", "  }"];
  return [...head, ...body, "  return sum;", "}", ""].join("\n");
};

/**
 * Deterministic in-memory backend used in the browser (`?scenario=`) and in tests.
 * Scenarios: `normal`, `big` (5,000 changes in admin), `failures` (backend hook rejects, admin push is non-fast-forward,
 * services hits lockBusy once, shop-pos cannot be read), `empty`, `merging` (services mid-merge). Unknown names fall back to `normal`.
 */
export function createMockIpc(scenario: string = "normal", options: MockOptions = {}): Ipc {
  // `?delay=0` makes the browser mock instant (screenshots, quick manual runs); the default keeps loading states visible.
  const scale = options.delayScale ?? (Number(new URLSearchParams(globalThis.location?.search).get("delay") ?? 1) || 0);
  const scenarioSet = scenarioRepos((SCENARIOS as readonly string[]).includes(scenario) ? scenario : "normal");
  const query = new URLSearchParams(globalThis.location?.search);
  const registry =
    options.workspaces ??
    createMockWorkspaces({
      scenario,
      storage: options.persistRegistry ? safeStorage("localStorage") : null,
      session: options.persistRegistry ? safeStorage("sessionStorage") : null,
      seed: scenarioSet.map((r) => r.config),
      branches: Object.fromEntries(scenarioSet.map((r) => [r.config.id, r.branch])),
      pinned: query.get("pinned") === "1",
      latency: 0,
    });
  if (query.get("migrated") === "1" && !options.workspaces) registry.setJustMigrated(true);
  // `?busy=agent,devServer,gitRun` makes the browser mock report running work, to look at the switch guard.
  const busyKinds = (query.get("busy") ?? "").split(",").filter(Boolean);
  if (busyKinds.length && !options.workspaces) {
    const item = (kind: string) => ({ kind: kind as never, count: kind === "agent" ? 2 : 1, labels: kind === "devServer" ? ["api :3000"] : kind === "gitOp" ? ["rebase"] : [] });
    registry.setBusy({ blocking: busyKinds.filter((k) => k === "gitRun" || k === "gitOp").map(item), confirmable: busyKinds.filter((k) => k !== "gitRun" && k !== "gitOp" && k !== "unsaved").map(item) });
  }
  // The engine serves the open workspace of the registry (none while detached); the other repos of the scenario stay unused.
  const openFile = registry.activeWorkspace();
  const repos: MockRepo[] = openFile
    ? openFile.repos.map((c) => {
        const known = scenarioSet.find((r) => r.config.id === c.id);
        return known ? { ...known, config: c } : stubRepo(c);
      })
    : [];
  let workspace = openFile ?? workspaceFor([]);
  const revisions = new Map<string, number>();
  const cancelled = new Set<string>();
  /** Files of the commits made in this session; the seeded commits are listed below. */
  const commitFiles = new Map<string, ChangedFile[]>([
    [
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      [
        { path: "src/api/services/loyaltyService.js", kind: "added" },
        { path: "src/api/controllers/orderController.js", kind: "modified" },
        { path: "src/api/utils/legacyExport.js", kind: "deleted" },
      ],
    ],
    [
      "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1",
      [
        { path: "src/components/modules/orders/OrdersTable.tsx", kind: "modified" },
        { path: "src/components/layout/Header.tsx", kind: "modified" },
        { path: "src/theme/light.css", kind: "modified" },
      ],
    ],
  ]);

  if (scenario.startsWith("showcase")) {
    commitFiles.set("b2c3d4e5f60718293a4b5c6d7e8f9012345678a1", [
      { path: "src/components/modules/orders/OrdersTable.tsx", kind: "modified" },
      { path: "src/components/layout/Header.tsx", kind: "modified" },
      { path: "src/theme/dark.css", kind: "modified" },
    ]);
    commitFiles.set("c3d4e5f60718293a4b5c6d7e8f901234567a1b2", [
      { path: "src/api/services/loyaltyLedger.js", kind: "added" },
      { path: "src/api/migrations/20260928_points_ledger.js", kind: "added" },
    ]);
    commitFiles.set("d4e5f60718293a4b5c6d7e8f9012345678a1b2c3", [
      { path: "src/pos/receipt.js", kind: "modified" },
      { path: "src/pos/receipt.test.js", kind: "added" },
    ]);
  }

  const snapshotListeners = new Set<(s: RepoSnapshot) => void>();
  const eventListeners = new Set<(e: OpEvent) => void>();
  const resultListeners = new Set<(r: OpResult) => void>();
  const subscribe = <T>(set: Set<(v: T) => void>, cb: (v: T) => void): Unsubscribe => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  const emit = <T>(set: Set<(v: T) => void>, v: T): void => set.forEach((cb) => cb(v));

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms * scale));
  const repo = (id: string): MockRepo => {
    const r = repos.find((x) => x.config.id === id);
    if (!r) throw engineError("repoMissing", `Unknown repo ${id}`);
    return r;
  };

  const env: EnvStatus = { state: "ready", gitPath: "/usr/local/bin/git", nodePath: "/usr/local/bin/node", source: "login-shell" };

  function snapshot(r: MockRepo, bump = false): RepoSnapshot {
    const id = r.config.id;
    const revision = (revisions.get(id) ?? 0) + (bump ? 1 : 0);
    revisions.set(id, revision);
    return {
      repoId: id,
      revision,
      takenAtMs: Date.now(),
      head: { branch: r.branch, oid: "0123456789abcdef0123456789abcdef01234567", detached: false, unborn: false },
      upstream: { remote: "origin", branch: r.upstream.replace(/^origin\//, ""), gone: false },
      ahead: r.outgoing.length,
      behind: r.behind,
      state: r.state ?? "normal",
      hooks: { kind: "husky", path: ".husky/_" },
      changes: r.changes.map((c) => ({ ...c })),
      stashCount: r.stashCount ?? 0,
      worktreeCount: r.worktreeCount ?? 0,
      error: r.error,
    };
  }
  const publish = (r: MockRepo): void => emit(snapshotListeners, snapshot(r, true));

  const opEvent = (runId: string, repoId: string, kind: OpKind, status: OpEvent["status"], text?: string, percent?: number): void =>
    emit(eventListeners, { runId, repoId, kind, status, line: text ? { stream: "stderr", text } : undefined, percent });

  const finish = (runId: string, kind: OpKind, outcomes: RepoOutcome[]): void =>
    emit(resultListeners, { runId, kind, repos: outcomes, finishedAtMs: Date.now() });

  const outcome = (repoId: string, o: Partial<RepoOutcome>): RepoOutcome => ({
    repoId,
    status: "done",
    reconciled: true,
    hookModifiedFiles: [],
    ...o,
  });

  async function runCommit(req: CommitRequest): Promise<void> {
    await Promise.all(
      req.repos.map(async (rc) => {
        const r = repo(rc.repoId);
        const id = r.config.id;
        const fail = (status: RepoOutcome["status"], message: string, kind: NonNullable<RepoOutcome["failure"]>["kind"]) =>
          outcome(id, { status, failure: { kind, message } });
        opEvent(req.runId, id, "commit", "preparing");
        await sleep(150);
        if (!rc.message.trim()) return fail("failed", "Commit message is empty", "emptyMessage");
        if (r.lockBusyOnce) {
          r.lockBusyOnce = false;
          return fail("failed", "Another git process is using .git/index.lock. Try again in a moment.", "lockBusy");
        }
        if (!req.noVerify) {
          opEvent(req.runId, id, "commit", "hooks", "husky - pre-commit");
          await sleep(300);
          opEvent(req.runId, id, "commit", "hooks", "lint-staged: checking staged files");
          await sleep(300);
          if (r.hooksFail) return fail("failed", "pre-commit hook exited with code 1", "hookRejected");
        }
        if (cancelled.has(req.runId)) return outcome(id, { status: "cancelled" });
        opEvent(req.runId, id, "commit", "committing");
        await sleep(200);
        const paths = new Set(rc.files.map((f) => f.path));
        const kinds = new Map(r.changes.map((c) => [c.path, c.kind]));
        r.changes = r.changes.filter((c) => !paths.has(c.path));
        const oid = crypto.randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
        r.outgoing = [commitInfo(oid, rc.message.split("\n")[0], "Ferenc Farkas", 0), ...r.outgoing];
        commitFiles.set(
          oid,
          rc.files.map((f) => {
            const kind = kinds.get(f.path);
            return { path: f.path, kind: kind === undefined || kind === "untracked" ? "added" : kind };
          }),
        );
        publish(r);
        return outcome(id, { commitOid: oid });
      }),
    ).then((outcomes) => {
      finish(req.runId, "commit", outcomes);
    });
  }

  async function runPush(req: PushRequest): Promise<void> {
    const outcomes = await Promise.all(
      req.targets.map(async (t) => {
        const r = repo(t.repoId);
        const id = r.config.id;
        opEvent(req.runId, id, "push", "pushing", `Pushing to ${t.remote}/${t.remoteBranch}`);
        for (const pct of [20, 55, 90]) {
          await sleep(150);
          opEvent(req.runId, id, "push", "pushing", `Writing objects: ${pct}%`, pct);
        }
        if (cancelled.has(req.runId)) return outcome(id, { status: "cancelled" });
        if (r.pushRejected) {
          const to = `refs/heads/${t.remoteBranch}`;
          opEvent(req.runId, id, "push", "failed", `! [rejected]  ${r.branch} -> ${t.remoteBranch} (non-fast-forward)`);
          return outcome(id, {
            status: "failed",
            failure: { kind: "nonFastForward", message: `Updates were rejected because the tip of ${t.remote}/${t.remoteBranch} is ahead of your branch.` },
            pushResults: [{ flag: "!", from: `refs/heads/${r.branch}`, to, summary: "[rejected] (non-fast-forward)", reason: "non-fast-forward" }],
          });
        }
        const flag: PushFlag = r.outgoing.length > 0 ? " " : "=";
        const from = `refs/heads/${r.branch}`;
        const pushResults = [{ flag, from, to: `refs/heads/${t.remoteBranch}`, summary: `${r.outgoing[0]?.shortOid ?? "0000000"}..${r.outgoing.length}` }];
        r.outgoing = [];
        publish(r);
        return outcome(id, { pushResults });
      }),
    );
    finish(req.runId, "push", outcomes);
  }

  async function runSimple(runId: string, repoId: string, kind: "pull" | "fetch"): Promise<void> {
    const r = repo(repoId);
    opEvent(runId, repoId, kind, "preparing", kind === "pull" ? "Updating from origin" : "Fetching origin", 40);
    await sleep(400);
    if (kind === "pull") {
      r.behind = 0;
      r.pushRejected = false;
    }
    publish(r);
    finish(runId, kind, [outcome(repoId, {})]);
  }

  /** Starts `work` in the background so the command resolves immediately, like the real engine. */
  const background = (work: () => Promise<void>): void => void sleep(0).then(work);
  const started = (runId: string): RunStarted => ({ runId });

  return {
    workspaceGet: async () => {
      await sleep(80);
      return structuredClone(workspace);
    },
    workspaceSave: async (ws) => {
      workspace = registry.activeEntry() ? registry.saveActive(ws) : structuredClone(ws);
      return structuredClone(workspace);
    },
    engineStatus: async (): Promise<EngineStatus> => ({ env, repoIds: repos.map((r) => r.config.id) }),
    snapshotGet: async (repoId) => {
      // Staggered per repo so the loading skeletons are visible in the browser.
      await sleep(120 + repos.findIndex((r) => r.config.id === repoId) * 90);
      return snapshot(repo(repoId));
    },
    snapshotRefresh: async (repoId) => {
      for (const r of repos) if (repoId === null || r.config.id === repoId) publish(r);
    },
    listUntracked: async (repoId, dir, limit): Promise<UntrackedList> => {
      await sleep(120);
      const files = repo(repoId).untracked[dir] ?? [];
      return { files: files.slice(0, limit).map((p) => change(p, "untracked", { size: 900 })), truncated: files.length > limit };
    },
    fileContents: async (repoId, path, origPath, _source, reveal): Promise<FileContents> => {
      const guard = repo(repoId).changes.find((c) => c.path === path)?.guard ?? "ok";
      const hidden = (guard === "secret" || guard === "sensitive") && !reveal;
      return {
        path,
        original: hidden ? "" : sample(origPath ?? path, "original"),
        modified: hidden ? "" : sample(path, "modified"),
        binary: false,
        tooLarge: false,
        guard,
        language: path.split(".").pop(),
      };
    },
    fileHunks: async (_repoId, path): Promise<Hunk[]> => [
      {
        index: 0,
        header: "@@ -3,4 +3,6 @@ export function total(items) {",
        oldStart: 3,
        oldLines: 4,
        newStart: 3,
        newLines: 6,
        lines: [
          { kind: "context", text: "export function total(items) {" },
          { kind: "context", text: "  let sum = 0;" },
          { kind: "del", text: "  for (const it of items) sum += it.price;" },
          { kind: "add", text: "  for (const it of items) {" },
          { kind: "add", text: `    sum += it.price * (it.qty ?? 1); // ${path}` },
          { kind: "add", text: "  }" },
        ],
      },
      {
        index: 1,
        header: "@@ -20,3 +22,4 @@ export function format(value) {",
        oldStart: 20,
        oldLines: 3,
        newStart: 22,
        newLines: 4,
        lines: [
          { kind: "context", text: "export function format(value) {" },
          { kind: "add", text: "  if (value == null) return \"\";" },
          { kind: "context", text: "  return value.toFixed(2);" },
          { kind: "context", text: "}" },
        ],
      },
    ],
    commitMessageLast: async (repoId) => repo(repoId).outgoing[0]?.subject ?? "Initial commit",
    commitStart: async (req) => {
      background(() => runCommit(req));
      return started(req.runId);
    },
    commitCancel: async (runId) => void cancelled.add(runId),
    pushPlan: async (repoIds, _refetch): Promise<OutgoingInfo[]> =>
      repoIds.map((id) => {
        const r = repo(id);
        const target = r.config.pushTargets[r.branch] ?? { remote: "origin", branch: r.branch };
        const isProtected = workspace.protectedBranches.some((g) => globToRegExp(g).test(target.branch));
        return {
          repoId: id,
          local: r.branch,
          remote: target.remote,
          remoteBranch: target.branch,
          newRemoteBranch: false,
          protected: isProtected,
          commits: r.outgoing,
          checkedByDefault: r.outgoing.length > 0,
          canPush: true,
        };
      }),
    pushCommitFiles: async (_repoId, oid): Promise<ChangedFile[]> => commitFiles.get(oid) ?? [],
    pushStart: async (req) => {
      background(() => runPush(req));
      return started(req.runId);
    },
    pushCancel: async (runId) => void cancelled.add(runId),
    pull: async (repoId, _mode) => {
      const runId = crypto.randomUUID();
      background(() => runSimple(runId, repoId, "pull"));
      return started(runId);
    },
    fetch: async (repoId) => {
      const runId = crypto.randomUUID();
      background(() => runSimple(runId, repoId, "fetch"));
      return started(runId);
    },
    setPushTarget: async (repoId, localBranch, remote, branch) => {
      repo(repoId).config.pushTargets[localBranch] = { remote, branch };
      workspace = { ...workspace, repos: repos.map((r) => r.config) };
      if (registry.activeEntry()) registry.saveActive(workspace);
      return structuredClone(workspace);
    },
    execSurfaceCheck: async (paths) => paths.map(mockRunsCode),
    doctor: async () => ({
      gitPath: env.gitPath,
      gitVersion: "git version 2.51.0",
      credentialHelpers: ["osxkeychain"],
      pathHasNode: true,
      repos: repos.map((r) => ({ repoId: r.config.id, lsRemoteOk: true, hooks: { kind: "husky" as const, path: ".husky/_" } })),
    }),

    ...createMockAgents(scenario, scale),
    ...createMockNamespaces({
      repos: () =>
        repos.map((r) => ({
          id: r.config.id,
          branch: r.branch,
          upstream: r.upstream,
          ahead: r.outgoing.length,
          behind: r.behind,
          stashCount: r.stashCount ?? 0,
          blocked: r.state && r.state !== "normal" ? `The repository is in the middle of a ${r.state === "merging" ? "merge" : r.state}` : undefined,
        })),
      update: (repoId, patch) => {
        const r = repo(repoId);
        if (patch.branch !== undefined) {
          r.branch = patch.branch;
          r.upstream = patch.upstream ?? r.upstream;
        }
        r.stashCount = patch.stashCount ?? r.stashCount;
        publish(r);
      },
    }, registry),

    onRepoSnapshot: (cb) => subscribe(snapshotListeners, cb),
    onOpEvent: (cb) => subscribe(eventListeners, cb),
    onOpResult: (cb) => subscribe(resultListeners, cb),
    onEngineEnv: (cb) => {
      queueMicrotask(() => cb(env));
      return () => {};
    },
  };
}
