import type { EngineError } from "../../bindings";
import type {
  Capabilities,
  DirEntry,
  DirListing,
  DropEvent,
  ListOpts,
  NativeOptions,
  PathKind,
  Picked,
  PickPurpose,
  PickWarning,
  PickerIpc,
  ProtectedFolder,
  ScanOpts,
  ScanProgress,
  ScanResults,
  ScanStarted,
  StartInfo,
} from "../picker";
import { issueMockToken } from "./workspaces";

/*
 * The browser and test double of `intely-pathpick`: a small virtual file tree (home, a protected Documents folder that
 * answers `permissionDenied`, repos, a worktree, a bare repo, a non-git folder, an NFD name, a symlink, a slow folder, a
 * folder of 2100 entries, a risky repo) and the same error codes, token rules and limits as the Rust crate. Tokens are
 * issued through `issueMockToken`, so `ipc.workspaces` can redeem them. No filesystem is touched.
 */

export const MOCK_HOME = "/Users/example";
const MAX_ENTRIES = 2000;
const TOKEN_TTL_MS = 5 * 60_000;
const DROP_TTL_MS = 30_000;
const DROP_MAX = 64;
const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", "out", ".venv", "venv", "__pycache__", "Pods", "DerivedData", ".Trash", "Library", ".cache"]);

type NodeKind = "dir" | "file" | "symlinkDir" | "symlinkFile";

export interface GitSpec {
  shape: "repo" | "worktree" | "submodule" | "bare" | "redirect";
  branch?: string | null;
  detached?: boolean;
  risks?: string[];
  remotes?: Array<{ name: string; host: string }>;
  main?: string;
  redirectTarget?: string;
}

export interface MockNode {
  kind: NodeKind;
  children?: Record<string, MockNode>;
  git?: GitSpec;
  /** Symlinks: the absolute target. */
  target?: string;
  /** Reading the content of this folder answers `permissionDenied` until `grant()`. */
  denied?: boolean;
  /** Listing this folder takes this long (ms, scaled by `delayScale`). */
  slowMs?: number;
  size?: number;
  foreign?: boolean;
}

const dir = (children: Record<string, MockNode> = {}, extra: Partial<MockNode> = {}): MockNode => ({ kind: "dir", children, ...extra });
const file = (size = 120): MockNode => ({ kind: "file", size });
const repo = (children: Record<string, MockNode> = {}, git: Partial<GitSpec> = {}): MockNode => ({
  kind: "dir",
  children,
  git: { shape: "repo", branch: "main", ...git },
});

function bigFolder(): Record<string, MockNode> {
  const out: Record<string, MockNode> = {};
  for (let i = 0; i < 2100; i++) out[`item-${String(i).padStart(4, "0")}`] = dir();
  return out;
}

export function defaultTree(): MockNode {
  return dir({
    Users: dir({
      example: dir({
        Desktop: dir({ "todo.txt": file() }),
        Documents: dir({ Contracts: dir(), "notes.md": file(900) }, { denied: true }),
        Downloads: dir({ "installer.dmg": file(4_000_000) }),
        Projects: dir({
          api: repo({ src: dir({ "index.ts": file() }), "package.json": file(300) }, { remotes: [{ name: "origin", host: "github.com" }] }),
          "shop-frontend": repo({ src: dir() }, { branch: "develop", remotes: [{ name: "origin", host: "gitlab.example.com" }] }),
          "client-x": repo({}, { risks: ["core.fsmonitor", "hook:pre-commit"], branch: "main" }),
          docs: dir({ guides: dir(), "README.md": file() }),
          "feature-wt": repo({}, { shape: "worktree", branch: "feature/login", main: "/Users/example/Projects/api/.git" }),
          "vendor-sub": repo({}, { shape: "submodule" }),
          "legacy.git": repo({}, { shape: "bare" }),
          redirected: repo({}, { shape: "redirect", redirectTarget: "/Users/example/Projects/api/.git" }),
          "café": dir({ "menu.txt": file() }),
          "link-to-api": { kind: "symlinkDir", target: "/Users/example/Projects/api" },
          slow: dir({ inner: dir() }, { slowMs: 1200 }),
          big: dir(bigFolder()),
          monorepo: dir({ web: repo(), server: repo(), tools: dir({ scripts: dir() }), node_modules: dir({ dep: repo() }) }),
          "Tool.app": dir({ Contents: dir() }),
          "someone-elses": repo({}, { branch: "main" }),
        }),
        certs: dir({
          "ca.pem": file(1800),
          "client.crt": file(1200),
          "client.key": file(1700),
          "notes.txt": file(40),
          "bundle.p12": file(2400),
        }),
        ".ssh": dir({ id_ed25519: file(400), "id_ed25519.pub": file(100), known_hosts: file(2000) }),
        ".config": dir({ tool: dir() }),
        Library: dir({ Preferences: dir() }),
        "notes.txt": file(500),
        ".zshrc": file(300),
      }),
    }),
    Volumes: dir({ Backup: dir({ "old-repo": repo(), archive: dir() }) }),
    tmp: dir(),
  });
}

const err = (code: string, message: string, detail?: string): EngineError => ({ code, message, ...(detail ? { detail } : {}) });

export interface MockPickerOptions {
  /** `Capabilities.native`: the browser mock has no system dialog; tests that script one turn it on. */
  native?: boolean;
  mode?: Capabilities["mode"];
  /** E2e mode: every path outside this folder answers `testJail`; `start` returns it. */
  fixtureRoot?: string | null;
  tree?: MockNode;
  /** 0 = no artificial latency (tests); 1 = the real feel (default in the browser). */
  delayScale?: number;
  now?: () => number;
  /** Milliseconds between the directories of a scan (scaled by `delayScale`). */
  scanStepMs?: number;
}

export type MockAnswer = { paths: string[] } | { cancel: true } | { fail: true };

export interface MockPicker extends PickerIpc {
  /** Queue answers for the system dialog (the equivalent of `INTELY_PICK_SCRIPT`). An empty queue cancels. */
  script(...answers: MockAnswer[]): void;
  setMode(mode: Capabilities["mode"]): void;
  setNative(on: boolean): void;
  setFixtureRoot(root: string | null): void;
  /** Lets the folder be read (the user answered the macOS prompt with Allow). */
  grant(path: string): void;
  /** A window drop, as the Rust `DragDrop` hook would deliver it: ignored unless `dropListen(true)`. */
  emitDrop(paths: string[]): Promise<void>;
  /** How often `openPrivacySettings` was called. */
  privacyOpened(): number;
  /** The virtual tree, for scenarios and tests. */
  tree(): MockNode;
}

interface Issued {
  picked: Picked;
  path: string;
  purpose: string;
  at: number;
  used: boolean;
}

interface Resolved {
  node: MockNode;
  path: string;
  viaSymlink: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function protectedOf(path: string): ProtectedFolder | null {
  if (path.startsWith("/Volumes/")) return "volume";
  const rest = path.startsWith(`${MOCK_HOME}/`) ? path.slice(MOCK_HOME.length + 1).split("/") : [];
  switch (rest[0]) {
    case "Desktop":
      return "desktop";
    case "Documents":
      return "documents";
    case "Downloads":
      return "downloads";
    case "Movies":
      return "movies";
    case "Music":
      return "music";
    case "Pictures":
      return "pictures";
    case "Library":
      return rest[1] === "Mobile Documents" ? "icloud" : rest[1] === "CloudStorage" ? "cloudStorage" : "library";
    default:
      return null;
  }
}

/** The path conveniences of the Rust `hygiene` step: quotes, `file://`, escaped spaces, `~`. */
export function hygiene(raw: string): string {
  const bad = () => err("pathInvalid", "That is not a valid path.");
  if (!raw || raw.length > 4096) throw bad();
  let s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) throw bad();
  for (const q of ['"', "'"]) {
    if (s.length >= 2 && s.startsWith(q) && s.endsWith(q)) {
      s = s.slice(1, -1);
      break;
    }
  }
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.slice(7).replace(/^localhost/, ""));
    } catch {
      throw bad();
    }
  }
  s = s.replace(/\\ /g, " ");
  if (s === "~") return MOCK_HOME;
  if (s.startsWith("~/")) s = `${MOCK_HOME}/${s.slice(2)}`;
  else if (s.startsWith("~")) throw bad();
  if (!s.startsWith("/")) throw bad();
  return s;
}

function normalize(p: string): string[] {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

const toPath = (parts: string[]) => `/${parts.join("/")}`;
const dirname = (p: string) => toPath(normalize(p).slice(0, -1));
const basename = (p: string) => normalize(p).at(-1) ?? "/";
const hashOf = (s: string) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

const repoKind = (g?: GitSpec): PathKind => (g?.shape === "worktree" ? "worktree" : g?.shape === "submodule" ? "submodule" : "repo");
const isRepoShape = (g?: GitSpec) => !!g && g.shape !== "bare";

export function createMockPicker(opts: MockPickerOptions = {}): MockPicker {
  const root = opts.tree ?? defaultTree();
  let mode: Capabilities["mode"] = opts.mode ?? "off";
  let native = opts.native ?? false;
  let fixtureRoot: string | null = opts.fixtureRoot ?? (opts.mode === "e2e" ? `${MOCK_HOME}/Projects` : null);
  const scale = opts.delayScale ?? 1;
  const now = opts.now ?? Date.now;
  const stepMs = (opts.scanStepMs ?? 12) * scale;
  const granted = new Set<string>();
  const issued = new Map<string, Issued>();
  const answers: MockAnswer[] = [];
  const scanSubs = new Set<(p: ScanProgress) => void>();
  const dropSubs = new Set<(e: DropEvent) => void>();
  const scans = new Map<string, { cancel: boolean; progress: ScanProgress; repos: Picked[] }>();
  let inbox: Array<{ at: number; picked: Picked }> = [];
  let listening = false;
  let busy = false;
  let privacy = 0;
  let scanSeq = 0;
  let lastDir: string | null = null;

  const home = () => fixtureRoot ?? MOCK_HOME;

  function jail(path: string): void {
    if (mode === "e2e" && fixtureRoot && path !== fixtureRoot && !path.startsWith(`${fixtureRoot}/`)) {
      throw err("testJail", "Outside the test fixture folder.");
    }
  }

  function childOf(parent: MockNode, name: string): MockNode | undefined {
    const known = parent.children?.[name];
    if (known) return known;
    if (name === ".git" && parent.git && parent.git.shape !== "bare") {
      return dir({ HEAD: file(), config: file(), objects: dir(), refs: dir() });
    }
    return undefined;
  }

  /** Walks `abs` through the tree, following symlinks; `denied` folders refuse to be entered. */
  function resolve(abs: string, depth = 0): Resolved {
    if (depth > 8) throw err("io", "Too many levels of symbolic links.");
    const parts = normalize(abs);
    if (parts[0] === "Volumes" && parts[1] && !root.children?.Volumes?.children?.[parts[1]]) {
      throw err("volumeMissing", "The volume is not mounted.");
    }
    let node = root;
    let path: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (node.denied && !granted.has(toPath(path))) {
        throw err("permissionDenied", "Access was denied.", protectedOf(toPath(path)) ?? undefined);
      }
      const next = childOf(node, parts[i]);
      if (!next) throw err("notFound", "The folder does not exist.");
      path = [...path, parts[i]];
      if ((next.kind === "symlinkDir" || next.kind === "symlinkFile") && next.target) {
        const r = resolve(toPath([...normalize(next.target), ...parts.slice(i + 1)]), depth + 1);
        return { ...r, viaSymlink: true };
      }
      node = next;
    }
    return { node, path: toPath(path), viaSymlink: false };
  }

  function findNode(path: string): MockNode | undefined {
    try {
      return resolve(path).node;
    } catch {
      return undefined;
    }
  }

  const tooBroad = (p: string) =>
    p === "/" ||
    p === "/Users" ||
    p === MOCK_HOME ||
    p === "/Volumes" ||
    /^\/Volumes\/[^/]+$/.test(p) ||
    p.startsWith(`${MOCK_HOME}/.ssh`) ||
    p.startsWith(`${MOCK_HOME}/Library`);

  function warningsFor(path: string, git?: GitSpec, foreign?: boolean): PickWarning[] {
    const w: PickWarning[] = [];
    if (/Mobile Documents|CloudStorage|Dropbox|OneDrive|Google Drive/.test(path)) w.push("cloudFolder");
    if (path.startsWith("/Volumes/")) w.push("externalVolume");
    if (path.split("/").includes("node_modules")) w.push("insideIgnored");
    if (foreign) w.push("foreignOwner");
    if (git?.shape === "redirect") w.push("gitfileRedirect");
    if (git?.shape === "worktree" || git?.shape === "submodule") w.push("limitedSupport");
    return w;
  }

  function build(path: string, kind: PathKind, node: MockNode, purpose: string, via: boolean, extra: Partial<Picked> = {}): Picked {
    const git = node.git;
    const base: Picked = {
      token: "",
      path,
      name: basename(path).normalize("NFC"),
      kind,
      identity: `1:${hashOf(path)}`,
      root: null,
      main: git?.shape === "worktree" ? (git.main ?? null) : null,
      warnings: warningsFor(path, git, node.foreign),
      configRisks: [...(git?.risks ?? [])],
      remotes: [...(git?.remotes ?? [])],
      branch: git ? (git.branch ?? null) : null,
      detached: git?.detached ?? false,
      protectedFolder: protectedOf(path),
      viaSymlink: via,
      gitfileTarget: git?.shape === "redirect" ? (git.redirectTarget ?? null) : null,
      ...extra,
    };
    base.token = issueMockToken(
      {
        path,
        name: base.name,
        identity: base.identity,
        kind: kind === "worktree" || kind === "submodule" ? kind : "repo",
        configRisks: base.configRisks,
        remotes: (git?.remotes ?? []).map((r) => `${r.host}/${base.name}`),
        branch: base.branch,
      },
      purpose,
      now(),
    );
    issued.set(base.token, { picked: base, path, purpose, at: now(), used: false });
    return base;
  }

  function classify(r: Resolved, purpose: PickPurpose): Picked {
    const { node, path, viaSymlink } = r;
    if (purpose.startsWith("file:")) {
      if (node.kind !== "file" && node.kind !== "symlinkFile") throw err("notAFile", "That is not a file.");
      return build(path, "file", node, purpose, viaSymlink);
    }
    if (node.kind !== "dir" && node.kind !== "symlinkDir") throw err("notADirectory", "That is not a folder.");
    if (purpose === "scanRoot") return build(path, "folder", node, purpose, viaSymlink);
    const parts = normalize(path);
    const gitIdx = parts.indexOf(".git");
    if (gitIdx >= 0) {
      const parentPath = toPath(parts.slice(0, gitIdx));
      let rootPicked: Picked | null = null;
      try {
        const pr = resolve(parentPath);
        if (isRepoShape(pr.node.git)) rootPicked = build(parentPath, repoKind(pr.node.git), pr.node, purpose, false);
      } catch {
        rootPicked = null;
      }
      return build(path, "gitDir", node, purpose, viaSymlink, { root: rootPicked });
    }
    if (node.git?.shape === "bare") return build(path, "bare", node, purpose, viaSymlink);
    if (isRepoShape(node.git)) {
      if (tooBroad(path)) throw err("tooBroad", "This folder is too broad to be a repository.");
      return build(path, repoKind(node.git), node, purpose, viaSymlink);
    }
    for (let i = parts.length - 1; i > 0; i--) {
      const ap = toPath(parts.slice(0, i));
      if (ap === "/" || ap === "/Users") break;
      let anc: Resolved;
      try {
        anc = resolve(ap);
      } catch {
        continue;
      }
      if (isRepoShape(anc.node.git)) {
        if (tooBroad(ap)) throw err("tooBroad", "This folder is too broad to be a repository.");
        const rootPicked = build(ap, repoKind(anc.node.git), anc.node, purpose, false);
        return build(path, "subfolder", node, purpose, viaSymlink, { root: rootPicked });
      }
    }
    return build(path, "notGit", node, purpose, viaSymlink);
  }

  async function pick(rawPath: string, purpose: PickPurpose): Promise<Picked> {
    await sleep(8 * scale);
    if (!/^(workspaceRoot|workspaceRepo|scanRoot|file:[A-Za-z0-9_.-]{1,64})$/.test(purpose)) throw err("pathInvalid", "That is not a valid path.");
    const abs = hygiene(rawPath);
    jail(abs);
    const r = resolve(abs);
    jail(r.path);
    const picked = classify(r, purpose);
    lastDir = purpose.startsWith("file:") ? dirname(picked.path) : picked.path;
    return picked;
  }

  function toEntries(path: string, node: MockNode, o: ListOpts): { entries: DirEntry[]; seen: number } {
    const protectedParent = protectedOf(path) !== null;
    const names = new Set(Object.keys(node.children ?? {}));
    if (node.git && node.git.shape !== "bare") names.add(".git");
    const wanted = (o.extensions ?? []).map((e) => e.replace(/^\./, "").toLowerCase());
    const out: DirEntry[] = [];
    let probes = 0;
    for (const name of names) {
      const child = childOf(node, name);
      if (!child) continue;
      const hidden = name.startsWith(".");
      if (hidden && !o.hidden) continue;
      const isDir = child.kind === "dir" || child.kind === "symlinkDir";
      if (!isDir) {
        if (!o.files) continue;
        const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
        if (wanted.length && !wanted.includes(ext)) continue;
      }
      let kind: DirEntry["kind"] = child.kind;
      if (mode === "e2e" && fixtureRoot && child.target && !child.target.startsWith(fixtureRoot)) kind = "other";
      const childPath = `${path === "/" ? "" : path}/${name}`;
      const prot = protectedOf(childPath);
      let isRepo: boolean | null = null;
      if (isDir && !protectedParent && prot === null && probes < 400) {
        probes++;
        const target = child.target ? findNode(child.target) : child;
        isRepo = isRepoShape(target?.git);
      }
      out.push({
        name,
        label: name.normalize("NFC"),
        kind,
        hidden,
        isRepo,
        protectedFolder: prot,
        package: isDir && name.endsWith(".app"),
        size: isDir ? null : (child.size ?? 0),
      });
    }
    out.sort((a, b) => {
      const ar = a.kind === "dir" || a.kind === "symlinkDir" ? 0 : 1;
      const br = b.kind === "dir" || b.kind === "symlinkDir" ? 0 : 1;
      return ar - br || a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.label.localeCompare(b.label);
    });
    return { entries: out, seen: names.size };
  }

  async function list(rawPath: string, o: ListOpts = { hidden: false, files: false }): Promise<DirListing> {
    const abs = hygiene(rawPath);
    jail(abs);
    await sleep(6 * scale);
    const r = resolve(abs);
    jail(r.path);
    if (r.node.kind !== "dir" && r.node.kind !== "symlinkDir") throw err("notADirectory", "That is not a folder.");
    if (r.node.slowMs) await sleep(r.node.slowMs * scale);
    if (r.node.denied && !granted.has(r.path)) throw err("permissionDenied", "Access was denied.", protectedOf(r.path) ?? undefined);
    const { entries, seen } = toEntries(r.path, r.node, o);
    const parent = r.path === "/" || r.path === fixtureRoot ? null : dirname(r.path);
    return {
      path: r.path,
      parent,
      entries: entries.slice(0, MAX_ENTRIES),
      truncated: entries.length > MAX_ENTRIES,
      totalSeen: seen,
      skippedUnreadable: 0,
      protectedFolder: protectedOf(r.path),
    };
  }

  // -- scan ---------------------------------------------------------------------------------------------------------

  function emitScan(p: ScanProgress): void {
    scanSubs.forEach((cb) => cb({ ...p, skippedProtected: [...p.skippedProtected] }));
  }

  async function scanStart(rawPath: string, o: ScanOpts = { includeHidden: false }): Promise<ScanStarted> {
    const abs = hygiene(rawPath);
    jail(abs);
    const r = resolve(abs);
    if (r.node.kind !== "dir" && r.node.kind !== "symlinkDir") throw err("notADirectory", "That is not a folder.");
    if (r.path === "/") throw err("scanTooBroad", "Choose a more specific folder to scan.");
    const scanId = `scan-${++scanSeq}`;
    const progress: ScanProgress = { scanId, visited: 0, found: 0, done: false, cancelled: false, truncated: false, reason: null, skippedProtected: [], skippedSymlinks: 0 };
    const state = { cancel: false, progress, repos: [] as Picked[] };
    scans.set(scanId, state);
    const depth = Math.min(Math.max(o.depth ?? 3, 1), 5);
    const maxRepos = Math.min(o.maxRepos ?? 200, 200);
    const wide = r.path === MOCK_HOME || r.path === "/Users" || r.path === "/Volumes";
    const stack: Array<{ path: string; node: MockNode; d: number }> = [{ path: r.path, node: r.node, d: 0 }];
    const finish = (): false => {
      progress.done = true;
      emitScan(progress);
      return false;
    };
    /** One directory; `false` once the scan is over. */
    const step = (): boolean => {
      if (state.cancel) {
        progress.cancelled = true;
        return finish();
      }
      const cur = stack.pop();
      if (!cur) return finish();
      progress.visited++;
      const kids: Array<{ path: string; node: MockNode }> = [];
      for (const name of Object.keys(cur.node.children ?? {}).sort()) {
        const child = cur.node.children![name];
        if (child.kind === "symlinkDir" || child.kind === "symlinkFile") {
          progress.skippedSymlinks++;
          continue;
        }
        if (child.kind !== "dir") continue;
        if (SKIP.has(name) && !(name === "Library" && cur.path !== MOCK_HOME)) continue;
        if (name.startsWith(".") && !o.includeHidden) continue;
        const cp = `${cur.path === "/" ? "" : cur.path}/${name}`;
        if (wide && cur.path === r.path && protectedOf(cp)) {
          progress.skippedProtected.push(name);
          continue;
        }
        if (child.denied) continue;
        if (isRepoShape(child.git)) {
          try {
            state.repos.push(classify({ node: child, path: cp, viaSymlink: false }, "workspaceRepo"));
            progress.found++;
          } catch {
            /* a repo the real pipeline would refuse is skipped */
          }
          if (progress.found >= maxRepos) {
            progress.truncated = true;
            progress.reason = "repos";
            return finish();
          }
          continue;
        }
        kids.push({ path: cp, node: child });
      }
      if (cur.d + 1 >= depth) {
        if (kids.length) {
          progress.truncated = true;
          progress.reason ??= "depth";
        }
      } else {
        for (const k of kids.reverse()) stack.push({ ...k, d: cur.d + 1 });
      }
      return true;
    };
    // A timer per batch of directories keeps a big tree quick while the progress still arrives in steps.
    const tick = () => {
      for (let i = 0; i < 25; i++) if (!step()) return;
      emitScan(progress);
      setTimeout(tick, stepMs);
    };
    setTimeout(tick, stepMs);
    return { scanId };
  }

  // -- drops --------------------------------------------------------------------------------------------------------

  async function dropped(path: string): Promise<Picked | null> {
    const lower = path.toLowerCase();
    const unusable = [".app", ".dmg", ".iso", ".pkg"].some((e) => lower.endsWith(e));
    try {
      const abs = hygiene(path);
      jail(abs);
      const r = resolve(abs);
      const isDir = r.node.kind === "dir" || r.node.kind === "symlinkDir";
      if (!isDir || unusable) return build(r.path, "file", r.node, isDir ? "scanRoot" : "file:drop", r.viaSymlink);
      return classify(r, "workspaceRoot");
    } catch {
      return null;
    }
  }

  function initTooBroad(path: string): boolean {
    return (
      tooBroad(path) ||
      ["Desktop", "Documents", "Downloads"].some((d) => path === `${MOCK_HOME}/${d}`) ||
      ["/Applications", "/System", "/Library", "/private"].some((p) => path === p || path.startsWith(`${p}/`))
    );
  }

  const api: MockPicker = {
    async capabilities() {
      await sleep(6 * scale);
      return { native, fake: mode === "e2e", mode };
    },
    async start(): Promise<StartInfo> {
      await sleep(6 * scale);
      const h = home();
      const places: StartInfo["places"] = [{ id: "home", label: "Home", path: h, exists: true }];
      if (mode !== "e2e") {
        for (const label of ["Desktop", "Documents", "Downloads"]) places.push({ id: label.toLowerCase(), label, path: `${MOCK_HOME}/${label}`, exists: true });
      }
      const volumes = mode === "e2e" ? [] : Object.keys(root.children?.Volumes?.children ?? {}).map((name) => ({ name, path: `/Volumes/${name}` }));
      const keep = lastDir && (mode !== "e2e" || !fixtureRoot || lastDir.startsWith(fixtureRoot));
      return { home: h, startPath: keep && lastDir ? lastDir : h, places, volumes };
    },
    list,
    pick,
    async native(o: NativeOptions) {
      const purpose = o.purpose as PickPurpose;
      const fileKind = o.kind === "file" || o.kind === "files";
      if (fileKind !== purpose.startsWith("file:")) throw err("pathInvalid", "That is not a valid path.");
      if (!native) throw err("nativeFailed", "The system dialog could not be opened.");
      if (busy) throw err("busy", "A folder dialog is already open.");
      busy = true;
      try {
        await sleep(10 * scale);
        const next = answers.shift();
        if (!next || "cancel" in next) return null;
        if ("fail" in next) throw err("nativeFailed", "The system dialog could not be opened.");
        const multi = o.kind === "folders" || o.kind === "files";
        const out: Picked[] = [];
        for (const p of next.paths.slice(0, multi ? 200 : 1)) out.push(await pick(p, purpose));
        return out.length ? out : null;
      } finally {
        busy = false;
      }
    },
    scanStart,
    async scanResults(scanId: string, after = 0): Promise<ScanResults> {
      const s = scans.get(scanId);
      if (!s) throw err("notFound", "Unknown scan.");
      return { repos: s.repos.slice(after), next: s.repos.length, progress: { ...s.progress } };
    },
    async scanCancel(scanId) {
      const s = scans.get(scanId);
      if (s) s.cancel = true;
    },
    async takeDrop() {
      const t = now();
      const out = inbox.filter((i) => t - i.at <= DROP_TTL_MS).map((i) => i.picked);
      inbox = [];
      return out;
    },
    async dropListen(on) {
      listening = on;
      if (!on) inbox = [];
    },
    async openPrivacySettings() {
      privacy++;
    },
    async gitInit(token, confirm, confirmLarge = false) {
      await sleep(6 * scale);
      if (mode === "readOnly") throw err("readOnly", "Read-only mode: nothing can be created.");
      const rec = issued.get(token);
      if (!rec) throw err("pathNotValidated", "That folder was not chosen through the picker.");
      if (rec.used) throw err("tokenUsed", "That choice was already used.");
      if (now() - rec.at > TOKEN_TTL_MS) throw err("tokenExpired", "That choice expired.");
      if (rec.picked.kind !== "notGit") throw err("pathInvalid", "Only a folder that is not a Git repository can be initialised.");
      jail(rec.path);
      if (initTooBroad(rec.path)) throw err("initTooBroad", "Git cannot be initialised in this folder.");
      const node = findNode(rec.path);
      if (!node) throw err("notFound", "The folder does not exist.");
      if (!confirmLarge && Object.keys(node.children ?? {}).length > 5000) throw err("initTooBroad", "The folder has more than 5000 entries.", "large");
      if (confirm.trim().normalize("NFC") !== rec.picked.name) throw err("pathInvalid", "The typed name does not match the folder name.", "confirm");
      rec.used = true;
      node.git = { shape: "repo", branch: "main" };
      return pick(rec.path, "workspaceRoot");
    },
    onScan(cb) {
      scanSubs.add(cb);
      return () => scanSubs.delete(cb);
    },
    onDrop(cb) {
      dropSubs.add(cb);
      return () => dropSubs.delete(cb);
    },
    script(...a) {
      answers.push(...a);
    },
    setMode(m) {
      mode = m;
      if (m === "e2e" && !fixtureRoot) fixtureRoot = `${MOCK_HOME}/Projects`;
      if (m !== "e2e") fixtureRoot = opts.fixtureRoot ?? null;
    },
    setNative(on) {
      native = on;
    },
    setFixtureRoot(r) {
      fixtureRoot = r;
    },
    grant(path) {
      granted.add(toPath(normalize(path)));
    },
    async emitDrop(paths) {
      if (!listening) return;
      const t = now();
      inbox = inbox.filter((i) => t - i.at <= DROP_TTL_MS);
      for (const p of paths.slice(0, DROP_MAX)) {
        const picked = await dropped(p);
        if (picked && inbox.length < DROP_MAX) inbox.push({ at: t, picked });
      }
      dropSubs.forEach((cb) => cb({ count: inbox.length }));
    },
    privacyOpened: () => privacy,
    tree: () => root,
  };
  return api;
}

/**
 * Scenario knobs for the browser mock: `?picker=native,broad,readonly,e2e` (comma list). `native` offers the system dialog tab,
 * `broad` turns the home folder into a dotfiles repository (the too-broad card), `readonly` and `e2e` set the jail mode.
 */
export function pickerOptionsFromUrl(search: string): MockPickerOptions {
  const flags = new Set((new URLSearchParams(search).get("picker") ?? "").split(",").filter(Boolean));
  const opts: MockPickerOptions = {};
  if (flags.has("native")) opts.native = true;
  if (flags.has("readonly")) opts.mode = "readOnly";
  if (flags.has("e2e")) opts.mode = "e2e";
  if (flags.has("broad")) {
    const tree = defaultTree();
    tree.children!.Users.children!.example.git = { shape: "repo", branch: "main" };
    opts.tree = tree;
  }
  return opts;
}
