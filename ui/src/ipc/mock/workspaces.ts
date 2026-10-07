import type { EngineError, RepoConfig, Workspace } from "../../bindings";
import type { Unsubscribe } from "../index";
import { REPO_PALETTE } from "../../ui-kit/repoPalette";
import { SHOWCASE_ROOT, SHOWCASE_WORKSPACE } from "./showcase";
import type {
  BackupInfo,
  BusyReport,
  ChangedEvent,
  CreateRequest,
  CreateResult,
  RegistryProblem,
  RegistryView,
  RelocateRequest,
  RepoProbe,
  RepoRedeem,
  RepoStatus,
  Survivor,
  SwitchOptions,
  SwitchResult,
  SwitchingEvent,
  WorkspaceEntry,
  WorkspaceOrigin,
  WorkspaceProbe,
  WorkspaceSummary,
  WorkspacesIpc,
} from "../workspaces";

/*
 * The browser/test registry with the Rust semantics of (design notes: workspaces-spec) 4.3 to 4.12: name and colour rules, limits,
 * pinned mode, trust gate, identity reuse, busy report, probe statuses, epoch. State is persisted (reload-safe, because the
 * real app reloads the webview after every switch) when a `storage` is given; tests run in memory.
 */

export const MOCK_REGISTRY_KEY = "intely.mock.workspaces.v1";
const SEEDED_KEY = "intely.mock.workspaces.seeded";
export const MAX_WORKSPACES = 200;
export const MAX_REPOS = 100;
export const MIGRATED_ID = "w-migrated";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** What a redeemed picker token stands for (the real picker is `intely-pathpick`). */
export interface MockPicked {
  path: string;
  name?: string;
  identity?: string;
  kind?: "repo" | "worktree" | "submodule";
  configRisks?: string[];
  /** Host+path pairs of the remotes, for the relocate "different repository" check. */
  remotes?: string[];
  branch?: string | null;
}

interface TokenRecord {
  picked: MockPicked;
  purpose: string;
  expiresAt: number;
  used: boolean;
}

const tokens = new Map<string, TokenRecord>();
let tokenSeq = 0;
const TOKEN_TTL_MS = 5 * 60_000;

/**
 * Registers a validated path and returns its single-use token. The mock picker (`ipc.picker`) calls this when it answers
 * `pick`/`native`/`takeDrop`; `workspaces.create` and `addRepos` redeem it.
 */
export function issueMockToken(picked: MockPicked, purpose = "workspaceRepo", now = Date.now()): string {
  const token = `mock-token-${++tokenSeq}`;
  tokens.set(token, { picked, purpose, expiresAt: now + TOKEN_TTL_MS, used: false });
  return token;
}

/** `mock:<path>` and `mock-risky:<path>` are accepted without a table entry, so tests and e2e fakes can name a folder directly. */
function lookupToken(token: string, now: number): TokenRecord | undefined {
  const known = tokens.get(token);
  if (known) return known;
  const m = /^mock(-risky)?:(\/.*)$/.exec(token);
  if (!m) return undefined;
  // Stateless sugar: a fresh record on every lookup, so the same string can name the folder again in the next test.
  return { picked: { path: m[2], configRisks: m[1] ? ["core.fsmonitor"] : [] }, purpose: "workspaceRepo", expiresAt: now + TOKEN_TTL_MS, used: false };
}

const err = (code: string, message: string, detail?: string): EngineError => ({ code, message, ...(detail ? { detail } : {}) });

interface StoredEntry extends WorkspaceEntry {
  /** Set by scenarios: the workspace file is damaged. */
  damaged?: boolean;
}

interface Stored {
  rev: number;
  epoch: number;
  activeId: string | null;
  entries: StoredEntry[];
  files: Record<string, Workspace>;
  removed: Array<{ id: string; at: number; file: Workspace }>;
  problem: RegistryProblem | null;
  openError: RegistryView["openError"];
  crashLoop: RegistryView["crashLoop"];
  /** Set by the `migrated` knob: the first view after a migration says so, once. */
  justMigrated?: boolean;
  /** Remote key per repo path, for the relocate check. */
  remotes: Record<string, string[]>;
}

export interface MockWorkspacesOptions {
  /** Persists the registry here (reload-safe); omitted = in memory (tests). */
  storage?: StorageLike | null;
  /** Session storage for the "seeded this tab session" marker of the `welcome*` scenarios. */
  session?: StorageLike | null;
  scenario?: string;
  now?: () => number;
  /** The four-repo workspace of the normal scenarios (its ids and paths). */
  seed?: RepoConfig[];
  /** Branch per repo id, shown by `probe`. */
  branches?: Record<string, string>;
  /** `INTELY_WORKSPACE` is set: one synthetic entry, every mutation answers `pinned`. */
  pinned?: boolean;
  /** Latency of the commands in ms (0 = next microtask). */
  latency?: number;
}

export interface MockWorkspaces extends WorkspacesIpc {
  /** The open workspace file, or `null` while detached. */
  activeWorkspace(): Workspace | null;
  activeEntry(): WorkspaceEntry | null;
  /** `workspace_save` of the engine: stores the open workspace file. */
  saveActive(ws: Workspace): Workspace;
  epoch(): number;
  /** Test and scenario knobs. */
  setBusy(report: BusyReport | (() => BusyReport)): void;
  setProbe(path: string, status: RepoStatus): void;
  setSurvivors(list: Survivor[]): void;
  setNextSwitchFailure(error: EngineError | null): void;
  /** The next `list()` reports that this launch migrated the legacy file. */
  setJustMigrated(on: boolean): void;
  /** Called with the confirmable items a forced switch stops. */
  onStopped(cb: (report: BusyReport) => void): void;
  gateSet(): boolean;
  revealed(): Array<{ workspaceId: string; repoId: string }>;
  reset(): void;
}

const EMPTY_WORKSPACE = (): Workspace => ({
  version: 1,
  repos: [],
  protectedBranches: ["main", "master", "production", "release/*"],
  settings: { messageMode: "shared", untrackedChecked: false },
});

/** NFC, trimmed, 1..60 characters, no control, format (Cf) or line/paragraph separator characters. */
export function checkName(raw: string): { ok: true; name: string } | { ok: false; code: "invalidName" } {
  const name = raw.normalize("NFC").trim();
  if (!name || [...name].length > 60) return { ok: false, code: "invalidName" };
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)) return { ok: false, code: "invalidName" };
  return { ok: true, name };
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function slug(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "") || "repo";
}

/** FNV-1a, 10 hex digits: the mock stand-in for `hex10(sha256(canonical_path))`. */
function hex10(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of text) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0").slice(0, 10);
}

function badgeOf(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

function summarize(entry: WorkspaceEntry, file: Workspace | undefined): WorkspaceSummary {
  const repos = [...(file?.repos ?? [])].sort((a, b) => a.order - b.order);
  return { ...entry, repos: repos.map((r) => ({ id: r.id, name: r.name, color: r.color, badge: r.badge, path: r.path })) };
}

/** The seeded content of a scenario, as stored state. */
function seedState(scenario: string, seed: RepoConfig[], now: number): Stored {
  const base: Stored = { rev: 1, epoch: 1, activeId: null, entries: [], files: {}, removed: [], problem: null, openError: null, crashLoop: null, remotes: {} };
  const add = (id: string, name: string, color: string, repos: RepoConfig[], lastOpenedAt: number | null, origin: WorkspaceOrigin = "created"): void => {
    base.entries.push({ id, name, color, order: base.entries.length, createdAt: now - 30 * 86_400_000 + base.entries.length, lastOpenedAt, origin });
    base.files[id] = { ...EMPTY_WORKSPACE(), repos: structuredClone(repos) };
  };
  const day = 86_400_000;
  const hour = 3_600_000;
  const cfg = (id: string, path: string, name: string, color: string, badge: string, order: number): RepoConfig => ({ id, path, name, color, badge, order, pushTargets: {} });
  const side = [cfg("api-1a2b3c4d5e", "/Users/example/Projects/shop-api", "shop-api", "#3b9ae8", "SA", 0), cfg("web-5e4d3c2b1a", "/Users/example/Projects/shop-web", "shop-web", "#8b6cf0", "SW", 1)];
  const client = [cfg("crm-9f8e7d6c5b", "/Users/example/Clients/ClientX/crm", "crm", "#f0a23a", "CR", 0)];
  const docs = [cfg("docs-0a1b2c3d4e", "/Volumes/Backup/docs", "docs", "#26b5b0", "DO", 0), cfg("wiki-1b2c3d4e5f", "/Users/example/Projects/wiki", "wiki", "#e8669a", "WI", 1)];
  const ghost = [cfg("old-2c3d4e5f6a", "/Users/example/Projects/old-site", "old-site", "#ef7b5b", "OS", 0)];
  if (scenario === "showcase" || scenario === "showcase-welcome") {
    // The fictional demo registry of the website screenshots: "Acme Shop" (the scenario's four repos) and three more workspaces.
    const nw = [cfg("ios-3a4b5c6d7e", "/Users/demo/code/northwind-ios", "northwind-ios", "#3b9ae8", "NI", 0), cfg("and-4b5c6d7e8f", "/Users/demo/code/northwind-android", "northwind-android", "#4caf7d", "NA", 1), cfg("bff-5c6d7e8f9a", "/Users/demo/code/northwind-bff", "northwind-bff", "#8b6cf0", "NB", 2)];
    const tools = [cfg("cli-6d7e8f9a0b", "/Users/demo/code/ops-cli", "ops-cli", "#f0a23a", "OC", 0), cfg("dash-7e8f9a0b1c", "/Users/demo/code/ops-dashboard", "ops-dashboard", "#e8669a", "OD", 1)];
    const site = [cfg("web-8f9a0b1c2d", "/Users/demo/code/marketing-site", "marketing-site", "#26b5b0", "MS", 0), cfg("cms-9a0b1c2d3e", "/Users/demo/code/content-cms", "content-cms", "#ef7b5b", "CC", 1)];
    add(MIGRATED_ID, "Acme Shop", "#8b6cf0", seed, now - (scenario === "showcase" ? 1000 : 25 * 60_000), "created");
    add("w3f9a1c2b4", "Northwind Apps", "#3b9ae8", nw, now - 3 * 3_600_000);
    add("w7c1d2e3f4", "Internal Tools", "#f0a23a", tools, now - 2 * day);
    add("wd0c5b6a79", "Marketing Site", "#26b5b0", site, now - 6 * day);
    base.activeId = scenario === "showcase" ? MIGRATED_ID : null;
    return base;
  }
  if (scenario === "showcase" || scenario === "showcase-welcome") {
    // The website demo: fictional names and folders only.
    const mobile = [cfg("mobile-6a7b8c9d0e", `${SHOWCASE_ROOT}/acme-mobile`, "acme-mobile", "#3b9ae8", "AM", 0)];
    const site = [cfg("site-1f2e3d4c5b", `${SHOWCASE_ROOT}/acme-site`, "acme-site", "#26b5b0", "AS", 0), cfg("docs-2a3b4c5d6e", `${SHOWCASE_ROOT}/acme-docs`, "acme-docs", "#e8669a", "AD", 1)];
    add(MIGRATED_ID, SHOWCASE_WORKSPACE, "#8b6cf0", seed, now - (scenario === "showcase" ? 1000 : 3 * hour), "migrated");
    add("w3f9a1c2b4", "Mobile app", "#3b9ae8", mobile, now - 2 * day);
    add("w7c1d2e3f4", "Website and docs", "#26b5b0", site, now - 6 * day);
    if (scenario === "showcase") base.activeId = MIGRATED_ID;
    return base;
  }
  if (scenario === "welcome") return base;
  if (scenario.startsWith("welcome-")) {
    const kind = scenario.slice("welcome-".length);
    if (kind === "recents" || kind === "readonly" || kind === "crashloop" || kind === "other") {
      add(MIGRATED_ID, "Happy workspace", "#8b6cf0", seed, now - 2 * day, "migrated");
      add("w3f9a1c2b4", "Side projects", "#3b9ae8", side, now - 5 * day);
      add("w7c1d2e3f4", "Client X", "#f0a23a", client, now - 9 * day);
      add("wd0c5b6a79", "Docs and wiki", "#26b5b0", docs, now - 20 * day);
      add("w2b3c4d5e6", "Experiments", "#e8669a", side.slice(0, 1), null);
      if (kind === "crashloop") base.crashLoop = { id: MIGRATED_ID, name: "Happy workspace" };
      if (kind === "other") base.problem = { kind: "otherInstance", message: "", backups: [] };
      return base;
    }
    if (kind === "vanished") {
      add(MIGRATED_ID, "Happy workspace", "#8b6cf0", seed, now - 2 * day, "migrated");
      add("w3f9a1c2b4", "Side projects", "#3b9ae8", side, now - 5 * day);
      add("wd0c5b6a79", "Docs and wiki", "#26b5b0", docs, now - 7 * day);
      add("w7c1d2e3f4", "Client X", "#f0a23a", client, now - 9 * day);
      add("w9a8b7c6d5", "Old site", "#ef7b5b", ghost, now - 40 * day);
      base.openError = { id: "w9a8b7c6d5", reason: "allMissing" };
      return base;
    }
    if (kind === "problem" || kind === "newer" || kind === "legacy") {
      const backups: BackupInfo[] = [
        { name: `workspaces.${now - day}-r12.json`, at: now - day, workspaces: 4 },
        { name: `workspaces.${now - 3 * day}-r9.json`, at: now - 3 * day, workspaces: 3 },
      ];
      base.problem =
        kind === "problem"
          ? { kind: "corrupt", message: "expected `,` or `}` at line 14 column 3", backups }
          : kind === "newer"
            ? { kind: "newerVersion", message: "version 2", backups: [] }
            : { kind: "legacyUnreadable", message: "workspace.json: missing field `repos`", backups: [] };
      return base;
    }
  }
  // normal and every other scenario: the migrated four-repo workspace is open, two more are listed.
  add(MIGRATED_ID, "Happy workspace", "#8b6cf0", seed, now - 1000, "migrated");
  add("w3f9a1c2b4", "Side projects", "#3b9ae8", side, now - 5 * day);
  add("w7c1d2e3f4", "Client X", "#f0a23a", client, now - 9 * day);
  base.activeId = MIGRATED_ID;
  return base;
}

/** Statuses a scenario shows on the Welcome list (paths that are not listed here are `ok`). */
function scenarioProbe(scenario: string): Record<string, RepoStatus> {
  if (scenario === "welcome-vanished") {
    return {
      "/Users/example/Projects/old-site": "missing",
      "/Volumes/Backup/docs": "volumeMissing",
      "/Users/example/Clients/ClientX/crm": "noAccess",
      "/Users/example/Projects/shop-web": "missing",
    };
  }
  return {};
}

export function createMockWorkspaces(options: MockWorkspacesOptions = {}): MockWorkspaces {
  const scenario = options.scenario ?? "normal";
  const now = options.now ?? Date.now;
  const store = options.storage ?? null;
  const latency = options.latency ?? 0;
  const seedRepos = options.seed ?? [];
  const pinned = options.pinned ?? false;
  const branches = options.branches ?? {};
  const probeOverrides: Record<string, RepoStatus> = { ...scenarioProbe(scenario) };
  let busyReport: BusyReport | (() => BusyReport) = { blocking: [], confirmable: [] };
  let survivorList: Survivor[] = [];
  let lastSurvivors: Survivor[] = [];
  let nextFailure: EngineError | null = null;
  let gate = false;
  let stopped: Array<(r: BusyReport) => void> = [];
  const revealLog: Array<{ workspaceId: string; repoId: string }> = [];
  const switching = new Set<(e: SwitchingEvent) => void>();
  const changed = new Set<(e: ChangedEvent) => void>();
  const listChanged = new Set<(e: { rev: number }) => void>();

  const freshState = (): Stored => seedState(scenario, seedRepos, now());
  const load = (): Stored => {
    if (store) {
      try {
        const resetting = scenario.startsWith("welcome");
        const marker = options.session?.getItem(SEEDED_KEY);
        if (resetting && marker !== scenario) {
          store.removeItem(MOCK_REGISTRY_KEY);
          options.session?.setItem(SEEDED_KEY, scenario);
        }
        const raw = store.getItem(MOCK_REGISTRY_KEY);
        if (raw) return JSON.parse(raw) as Stored;
      } catch {
        /* unreadable or blocked storage: start from the seed */
      }
    }
    return freshState();
  };
  let state = load();
  const save = (): void => {
    state.rev += 1;
    if (!store) return;
    try {
      store.setItem(MOCK_REGISTRY_KEY, JSON.stringify(state));
    } catch {
      /* quota or blocked storage: the in-memory registry still works for this page */
    }
  };
  if (store) {
    try {
      if (!store.getItem(MOCK_REGISTRY_KEY)) store.setItem(MOCK_REGISTRY_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  const wait = (): Promise<void> => new Promise((r) => (latency > 0 ? setTimeout(r, latency) : queueMicrotask(r)));
  const guardPinned = (): void => {
    if (pinned) throw err("pinned", "Fixed by INTELY_WORKSPACE");
  };
  const entryOf = (id: string): StoredEntry => {
    const e = state.entries.find((x) => x.id === id);
    if (!e) throw err("workspaceNotFound", "This workspace no longer exists.");
    return e;
  };
  const sortedEntries = (): StoredEntry[] => [...state.entries].sort((a, b) => a.order - b.order);
  const renumber = (): void => state.entries.forEach((e, i) => void (e.order = i));
  const strip = ({ damaged: _d, ...e }: StoredEntry): WorkspaceEntry => e;
  const notifyList = (): void => listChanged.forEach((cb) => cb({ rev: state.rev }));

  const nameProblem = (raw: string, exceptId?: string): string => {
    const r = checkName(raw);
    if (!r.ok) throw err(r.code, "The name must be 1 to 60 characters without control characters.");
    if (state.entries.some((e) => e.id !== exceptId && e.name.toLowerCase() === r.name.toLowerCase())) throw err("duplicateName", "A workspace with this name already exists.");
    return r.name;
  };
  const uniqueName = (base: string): string => {
    let name = base;
    for (let n = 2; state.entries.some((e) => e.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} (${n})`;
    return name;
  };
  const colorOf = (raw: string | undefined, taken: string[]): string => {
    if (raw !== undefined) {
      if (!COLOR_RE.test(raw)) throw err("invalidColor", "Use a colour like #8b6cf0.");
      return raw.toLowerCase();
    }
    return REPO_PALETTE.find((c) => !taken.includes(c)) ?? REPO_PALETTE[taken.length % REPO_PALETTE.length];
  };

  interface Redeemed {
    path: string;
    name: string;
    identity: string;
    risks: string[];
    remotes: string[];
    record: TokenRecord;
  }
  /** Resolves tokens without consuming them: validates purpose, expiry, use and the trust gate. */
  const redeem = (req: RepoRedeem[], purposes: string[]): Redeemed[] =>
    req.map((r) => {
      const rec = lookupToken(r.token, now());
      if (!rec) throw err("tokenExpired", "That choice expired. Choose the folder again.", r.token);
      if (rec.used) throw err("tokenUsed", "That choice was already used. Choose the folder again.", r.token);
      if (now() > rec.expiresAt) throw err("tokenExpired", "That choice expired. Choose the folder again.", r.token);
      if (!purposes.includes(rec.purpose)) throw err("wrongPurpose", "That folder was chosen for another purpose.");
      const risks = rec.picked.configRisks ?? [];
      if (risks.length && !r.trust) throw err("trustRequired", "Tick \"I trust this repository\" first.", JSON.stringify(risks));
      const path = rec.picked.path.replace(/\/+$/, "") || "/";
      return { path, name: rec.picked.name ?? basename(path), identity: rec.picked.identity ?? path, risks, remotes: rec.picked.remotes ?? [], record: rec };
    });
  const consume = (list: Redeemed[]): void => list.forEach((r) => void (r.record.used = true));

  /** Existing repo id for this identity in any workspace file (I7/4.12), else slug + path hash, extended on a collision. */
  const repoIdFor = (path: string, name: string, identity: string): string => {
    for (const f of Object.values(state.files)) {
      const hit = f.repos.find((x) => x.path === identity || x.path === path);
      if (hit) return hit.id;
    }
    const all = new Set(Object.values(state.files).flatMap((f) => f.repos.map((x) => x.id)));
    let hash = hex10(path);
    let id = `${slug(name)}-${hash}`;
    for (let n = 0; all.has(id) && n < 8; n++) {
      hash += "0";
      id = `${slug(name)}-${hash}`;
    }
    return id;
  };

  const buildRepos = (list: Redeemed[], overrides: RepoRedeem[], existing: RepoConfig[]): RepoConfig[] => {
    const out = [...existing];
    list.forEach((r, i) => {
      const o = overrides[i];
      if (out.some((x) => x.path === r.path)) throw err("alreadyInWorkspace", "Already in this workspace.");
      const nameInfo = checkName(o.name?.trim() || r.name);
      if (!nameInfo.ok) throw err("invalidName", "The name must be 1 to 60 characters without control characters.");
      const name = nameInfo.name;
      if (o.color !== undefined && !COLOR_RE.test(o.color)) throw err("invalidColor", "Use a colour like #8b6cf0.");
      let badge = (o.badge ?? badgeOf(name)).trim();
      if (!badge || [...badge].length > 2) badge = badgeOf(name);
      out.push({
        id: repoIdFor(r.path, name, r.identity),
        path: r.path,
        name,
        color: o.color?.toLowerCase() ?? REPO_PALETTE.find((c) => !out.some((x) => x.color === c)) ?? REPO_PALETTE[out.length % REPO_PALETTE.length],
        badge,
        order: out.length,
        pushTargets: {},
      });
      state.remotes[r.path] = r.remotes;
    });
    if (out.length > MAX_REPOS) throw err("limitReached", "The limit of workspaces or repositories is reached.");
    return out;
  };

  const statusOf = (path: string): RepoStatus => probeOverrides[path] ?? "ok";
  const view = (): RegistryView => {
    if (pinned) {
      const file = state.files[state.activeId ?? ""] ?? EMPTY_WORKSPACE();
      const entry: WorkspaceEntry = { id: "pinned", name: "pinned", color: "#8b6cf0", order: 0, createdAt: 0, lastOpenedAt: null, origin: "migrated" };
      return { version: 1, rev: state.rev, epoch: state.epoch, activeId: "pinned", pinned: true, workspaces: [summarize(entry, file)], problem: null, openError: null, crashLoop: null };
    }
    return {
      version: 1,
      rev: state.rev,
      epoch: state.epoch,
      activeId: state.activeId,
      pinned: false,
      workspaces: sortedEntries().map((e) => summarize(strip(e), state.files[e.id])),
      problem: state.problem,
      openError: state.openError,
      crashLoop: state.crashLoop ?? null,
      ...(state.justMigrated ? { justMigrated: true } : {}),
    };
  };

  const currentBusy = (): BusyReport => (typeof busyReport === "function" ? busyReport() : busyReport);

  const api: MockWorkspaces = {
    async list() {
      await wait();
      const v = structuredClone(view());
      state.justMigrated = false;
      return v;
    },
    async probe(ids) {
      await wait();
      const entries = sortedEntries().filter((e) => !ids || ids.includes(e.id));
      return entries.map<WorkspaceProbe>((e) => ({
        id: e.id,
        repos: (state.files[e.id]?.repos ?? []).map<RepoProbe>((r) => {
          const status = statusOf(r.path);
          return { repoId: r.id, status, branch: status === "ok" ? (branches[r.id] ?? "main") : null, detached: false };
        }),
      }));
    },
    async create(req: CreateRequest): Promise<CreateResult> {
      await wait();
      guardPinned();
      if (state.entries.length >= MAX_WORKSPACES) throw err("limitReached", "The limit of workspaces or repositories is reached.");
      const name = nameProblem(req.name);
      const color = colorOf(req.color, state.entries.map((e) => e.color));
      const list = redeem(req.repos, ["workspaceRepo", "workspaceRoot"]);
      // The same folder set again opens the existing workspace instead of creating a duplicate (3.3).
      const idents = new Set(list.map((r) => r.path));
      if (list.length) {
        const hit = state.entries.find((e) => {
          const paths = (state.files[e.id]?.repos ?? []).map((r) => r.path);
          return paths.length === idents.size && paths.every((p) => idents.has(p));
        });
        if (hit) {
          consume(list);
          return { entry: strip(hit), reused: true };
        }
      }
      const repos = buildRepos(list, req.repos, []);
      consume(list);
      const id = `w${hex10(`${name}${now()}${state.rev}`)}`;
      const entry: StoredEntry = { id, name, color, order: state.entries.length, createdAt: now(), lastOpenedAt: null, origin: req.origin ?? "created" };
      state.entries.push(entry);
      state.files[id] = { ...EMPTY_WORKSPACE(), repos };
      save();
      notifyList();
      return { entry: strip(entry), reused: false };
    },
    async rename(id, rawName) {
      await wait();
      guardPinned();
      const e = entryOf(id);
      e.name = nameProblem(rawName, id);
      save();
      notifyList();
      return strip(e);
    },
    async recolor(id, color) {
      await wait();
      guardPinned();
      const e = entryOf(id);
      e.color = colorOf(color, []);
      save();
      notifyList();
      return strip(e);
    },
    async duplicate(id, name) {
      await wait();
      guardPinned();
      if (state.entries.length >= MAX_WORKSPACES) throw err("limitReached", "The limit of workspaces or repositories is reached.");
      const src = entryOf(id);
      const finalName = name !== undefined ? nameProblem(name) : uniqueName(`${src.name} copy`);
      const newId = `w${hex10(`${finalName}${now()}${state.rev}`)}`;
      const entry: StoredEntry = { id: newId, name: finalName, color: src.color, order: state.entries.length, createdAt: now(), lastOpenedAt: null, origin: "duplicate" };
      state.entries.push(entry);
      state.files[newId] = structuredClone(state.files[id] ?? EMPTY_WORKSPACE());
      save();
      notifyList();
      return strip(entry);
    },
    async remove(id, confirm) {
      await wait();
      guardPinned();
      if (!confirm) throw err("confirmRequired", "Confirmation is required to remove a workspace.");
      const e = entryOf(id);
      if (state.activeId === id) throw err("workspaceActive", "Close the workspace before removing it.");
      state.entries = state.entries.filter((x) => x !== e);
      renumber();
      state.removed = [...state.removed, { id, at: now(), file: state.files[id] ?? EMPTY_WORKSPACE() }].slice(-20);
      delete state.files[id];
      if (state.openError?.id === id) state.openError = null;
      save();
      notifyList();
    },
    async reorder(ids) {
      await wait();
      guardPinned();
      const have = new Set(state.entries.map((e) => e.id));
      if (ids.length !== have.size || ids.some((i) => !have.has(i)) || new Set(ids).size !== ids.length) throw err("workspaceNotFound", "This workspace no longer exists.");
      ids.forEach((i, order) => void (entryOf(i).order = order));
      save();
      notifyList();
    },
    async busy() {
      await wait();
      return structuredClone(currentBusy());
    },
    async switch(id: string | null, opts: SwitchOptions): Promise<SwitchResult> {
      await wait();
      guardPinned();
      if (gate) throw err("workspaceSwitching", "A switch is in progress. Try again in a moment.");
      if (id !== null) {
        const e = entryOf(id);
        if (e.damaged || !state.files[id]) throw err("invalidWorkspace", "The workspace file is damaged.");
      }
      const report = currentBusy();
      if (report.blocking.length || (report.confirmable.length && !opts.force)) throw err("workspaceBusy", "Something is still running.", JSON.stringify(report));
      if (nextFailure) {
        const f = nextFailure;
        nextFailure = null;
        throw f;
      }
      const from = state.activeId;
      gate = true;
      const timer = setTimeout(() => void (gate = false), 15_000) as unknown as { unref?: () => void };
      timer.unref?.();
      switching.forEach((cb) => cb({ fromId: from, toId: id, epoch: state.epoch + 1 }));
      if (report.confirmable.length) {
        stopped.forEach((cb) => cb(report));
        busyReport = { blocking: [], confirmable: [] };
      }
      state.epoch += 1;
      if (opts.keepActive) {
        // Detached but still "open" in the registry: the next page shows Welcome with this entry flagged.
        if (state.activeId !== null) state.openError = { id: state.activeId, reason: "allMissing" };
      } else {
        state.activeId = id;
        if (id !== null) entryOf(id).lastOpenedAt = now();
        state.openError = null;
      }
      state.crashLoop = null;
      save();
      lastSurvivors = survivorList;
      const result: SwitchResult = { activeId: opts.keepActive ? state.activeId : id, epoch: state.epoch, warnings: [], survivors: structuredClone(survivorList) };
      changed.forEach((cb) => cb({ activeId: result.activeId, epoch: state.epoch }));
      notifyList();
      return result;
    },
    async ready(epoch) {
      await wait();
      if (epoch !== state.epoch) throw err("staleEpoch", "This page is out of date and is reloading.");
      gate = false;
      state.crashLoop = null;
    },
    async killSurvivor(pid) {
      await wait();
      if (!lastSurvivors.some((s) => s.pid === pid)) throw err("notFound", "Folder not found.");
      lastSurvivors = lastSurvivors.filter((s) => s.pid !== pid);
      survivorList = survivorList.filter((s) => s.pid !== pid);
    },
    async addRepos(repos) {
      await wait();
      guardPinned();
      if (gate) throw err("workspaceSwitching", "A switch is in progress. Try again in a moment.");
      const id = state.activeId;
      if (id === null) throw err("noWorkspace", "No workspace is open.");
      const file = state.files[id] ?? EMPTY_WORKSPACE();
      const list = redeem(repos, ["workspaceRepo", "workspaceRoot"]);
      const next = buildRepos(list, repos, file.repos);
      consume(list);
      state.files[id] = { ...file, repos: next };
      save();
      notifyList();
      return structuredClone(state.files[id]);
    },
    async relocateRepo(req: RelocateRequest) {
      await wait();
      guardPinned();
      const wsId = req.workspaceId ?? state.activeId;
      if (wsId === null || !state.files[wsId]) throw err("noWorkspace", "No workspace is open.");
      const file = state.files[wsId];
      const repo = file.repos.find((r) => r.id === req.repoId);
      if (!repo) throw err("pathNotValidated", "That folder was not chosen through the picker.");
      const [got] = redeem([{ token: req.token, trust: req.trust }], ["workspaceRepo", "workspaceRoot"]);
      const old = state.remotes[repo.path] ?? [];
      const disjoint = old.length > 0 && got.remotes.length > 0 && !old.some((x) => got.remotes.includes(x));
      if (disjoint && !req.confirmDifferent) throw err("confirmDifferent", "This folder looks like a different repository.");
      if (file.repos.some((r) => r.id !== repo.id && r.path === got.path)) throw err("alreadyInWorkspace", "Already in this workspace.");
      consume([got]);
      repo.path = got.path;
      state.remotes[got.path] = got.remotes;
      save();
      notifyList();
    },
    async reveal(workspaceId, repoId) {
      await wait();
      const repo = state.files[workspaceId]?.repos.find((r) => r.id === repoId);
      if (!repo) throw err("workspaceNotFound", "This workspace no longer exists.");
      revealLog.push({ workspaceId, repoId });
    },
    async restoreBackup(backupName) {
      await wait();
      guardPinned();
      if (!state.problem?.backups.some((b) => b.name === backupName)) throw err("notFound", "Folder not found.");
      state = { ...seedState("welcome-recents", seedRepos, now()), rev: state.rev, epoch: state.epoch };
      save();
      notifyList();
      return structuredClone(view());
    },
    async startFresh() {
      await wait();
      guardPinned();
      state = { ...seedState("welcome", seedRepos, now()), rev: state.rev, epoch: state.epoch };
      save();
      notifyList();
      return structuredClone(view());
    },
    onSwitching(cb): Unsubscribe {
      switching.add(cb);
      return () => void switching.delete(cb);
    },
    onChanged(cb): Unsubscribe {
      changed.add(cb);
      return () => void changed.delete(cb);
    },
    onListChanged(cb): Unsubscribe {
      listChanged.add(cb);
      return () => void listChanged.delete(cb);
    },

    activeWorkspace() {
      const id = state.activeId;
      if (id !== null && state.openError?.id === id) return null;
      return id !== null && state.files[id] ? structuredClone(state.files[id]) : null;
    },
    activeEntry() {
      const e = state.entries.find((x) => x.id === state.activeId);
      return e ? strip(e) : null;
    },
    saveActive(ws) {
      const id = state.activeId;
      if (id === null) throw err("noWorkspace", "No workspace is open.");
      state.files[id] = structuredClone(ws);
      save();
      return structuredClone(ws);
    },
    epoch: () => state.epoch,
    setBusy(report) {
      busyReport = report;
    },
    setProbe(path, status) {
      probeOverrides[path] = status;
    },
    setSurvivors(list) {
      survivorList = list;
    },
    setNextSwitchFailure(e) {
      nextFailure = e;
    },
    setJustMigrated(on) {
      state.justMigrated = on;
    },
    onStopped(cb) {
      stopped = [...stopped, cb];
    },
    gateSet: () => gate,
    revealed: () => revealLog,
    reset() {
      state = freshState();
      gate = false;
      save();
    },
  };
  return api;
}
