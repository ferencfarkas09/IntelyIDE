import type { RepoState, ServerCfg, ServerDraft, ServersIpc, ServerStatus, SetupEvent, SetupOptions, SetupStepName } from "../servers";

export interface MockServersOptions {
  /** Start with the three demo servers (default) or with none. */
  seed?: boolean;
  /** Pause of a check or a setup step in ms; 0 answers at once (default 350). */
  stepMs?: number;
}

export interface MockServersHandle extends ServersIpc {
  /** Pretend that `n` runs are live on a server. */
  setRunning(id: string, n: number): void;
  /** The next setup of the server fails at this step. */
  failSetupAt(step: SetupStepName | undefined): void;
}

const CHECKED_AT = "2026-10-10T08:00:00.000Z";
const STEPS: SetupStepName[] = ["probe", "prepare", "node", "bundle", "sdk", "claude", "verify"];

const READY: ServerStatus = {
  reachable: true,
  os: "linux",
  arch: "x64",
  home: "/home/me",
  node: { version: "v24.13.0", path: "/home/me/.intely/node/bin/node", ok: true },
  claude: { path: "/usr/local/bin/claude", version: "2.1.4", loggedIn: true },
  git: { path: "/usr/bin/git", version: "2.43.0" },
  bundle: { version: "1.1.1", ok: true },
  sdk: { ok: true, version: "0.3.287" },
  ready: true,
  checkedAt: CHECKED_AT,
};

const BARE: ServerStatus = {
  reachable: true,
  os: "linux",
  arch: "x64",
  home: "/home/x",
  node: { version: "v18.19.1", path: "/usr/bin/node", ok: false },
  claude: { loggedIn: null },
  git: { path: "/usr/bin/git", version: "2.34.1" },
  bundle: { ok: false },
  sdk: { ok: false, detail: "The Agent SDK is not installed." },
  ready: false,
  checkedAt: CHECKED_AT,
};

const UNREACHABLE: ServerStatus = {
  reachable: false,
  node: { ok: false },
  claude: {},
  git: {},
  bundle: { ok: false },
  sdk: { ok: false },
  ready: false,
  checkedAt: CHECKED_AT,
  error: { code: "hostKey", message: "Host key verification failed.", hint: "Connect once from a terminal so the host key is recorded: ssh old-box" },
};

const sum = (s: string) => [...s].reduce((n, c) => n + c.charCodeAt(0), 0);
const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
const reject = (code: string, message: string) => Promise.reject({ code, message });

/** In-memory servers for the browser dev server and the tests. Deterministic: the same call always gives the same answer. */
export function createMockServers(opts: MockServersOptions = {}): MockServersHandle {
  const stepMs = opts.stepMs ?? 350;
  const cfgs: ServerCfg[] =
    opts.seed === false
      ? []
      : [
          { id: "build-server", name: "Build server", destination: "build1", root: "~/work", maxAgents: 6, enabled: true },
          { id: "gpu-box", name: "GPU box", destination: "dev@gpu.example.com", port: 2222, root: "~/work", maxAgents: 2, enabled: true },
          { id: "old-box", name: "Old box", destination: "old-box", root: "~/work", maxAgents: 2, enabled: true },
        ];
  const statuses = new Map<string, ServerStatus>(opts.seed === false ? [] : [["build-server", READY], ["gpu-box", BARE], ["old-box", UNREACHABLE]]);
  const running = new Map<string, number>(opts.seed === false ? [] : [["build-server", 1]]);
  const cloned = new Map<string, Set<string>>();
  const setupSubs = new Set<(e: SetupEvent) => void>();
  const statusSubs = new Set<(id: string, s: ServerStatus) => void>();
  let failAt: SetupStepName | undefined;

  const pause = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)));
  const find = (id: string) => cfgs.find((c) => c.id === id);
  const missing = (id: string) => reject("notFound", `No server with the id ${id}.`);
  const emit = (e: SetupEvent) => setupSubs.forEach((cb) => cb(e));
  const publish = (id: string, s: ServerStatus) => (statuses.set(id, s), statusSubs.forEach((cb) => cb(id, s)));

  /** What a check finds today: a server that was set up is ready. */
  const check = (id: string): ServerStatus => statuses.get(id) ?? { ...BARE, checkedAt: CHECKED_AT };

  function validate(d: ServerDraft): void {
    const name = d.name.trim();
    if (!name) throw { code: "invalidName", message: "Give the server a name." };
    if (cfgs.some((c) => c.id !== d.id && c.name.toLowerCase() === name.toLowerCase())) throw { code: "duplicateName", message: `A server named ${name} already exists.` };
    const dest = d.destination.trim();
    if (!dest) throw { code: "invalidDestination", message: "Enter the SSH destination: a host from ~/.ssh/config, or user@host." };
    if (dest.startsWith("-") || /\s/.test(dest)) throw { code: "invalidDestination", message: "The SSH destination must not contain spaces or start with a dash." };
    if (d.port !== undefined && (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535)) throw { code: "invalidPort", message: "The port must be between 1 and 65535." };
    if (!d.root.trim()) throw { code: "invalidRoot", message: "Enter the folder on the server that holds the repositories." };
    if (!Number.isInteger(d.maxAgents) || d.maxAgents < 1 || d.maxAgents > 64) throw { code: "invalidMaxAgents", message: "Max agents must be between 1 and 64." };
  }

  function stepPlan(options: SetupOptions, status: ServerStatus): { step: SetupStepName; skip?: string }[] {
    return STEPS.map((step) => {
      if (step === "node" && (!options.installNode || status.node.ok)) return { step, skip: status.node.ok ? `Node ${status.node.version} is already there.` : "Not selected." };
      if (step === "bundle" && (!options.installBundle || status.bundle.ok)) return { step, skip: status.bundle.ok ? "The agent bundle is up to date." : "Not selected." };
      if (step === "sdk" && (!options.installSdk || status.sdk.ok)) return { step, skip: status.sdk.ok ? "The Agent SDK is already installed." : "Not selected." };
      if (step === "claude" && (!options.installClaude || status.claude.path)) return { step, skip: status.claude.path ? "Claude Code is already installed." : "Not selected." };
      return { step };
    });
  }

  const STARTED: Record<SetupStepName, string> = {
    probe: "Connecting and reading the server",
    prepare: "Preparing ~/.intely",
    node: "Installing Node 24",
    bundle: "Uploading the agent bundle",
    sdk: "Installing the Agent SDK",
    claude: "Installing Claude Code",
    verify: "Checking the result",
  };

  return {
    setRunning: (id, n) => void running.set(id, n),
    failSetupAt: (step) => void (failAt = step),
    async list() {
      return cfgs.map((cfg) => ({ cfg: { ...cfg }, ...(statuses.has(cfg.id) ? { status: statuses.get(cfg.id) } : {}), running: running.get(cfg.id) ?? 0 }));
    },
    async save(draft) {
      validate(draft);
      const base = { ...draft, name: draft.name.trim(), destination: draft.destination.trim(), root: draft.root.trim() };
      if (draft.id && find(draft.id)) {
        const i = cfgs.findIndex((c) => c.id === draft.id);
        cfgs[i] = { ...base, id: draft.id };
        return { ...cfgs[i] };
      }
      let id = slug(base.name);
      for (let n = 2; find(id); n++) id = `${slug(base.name)}-${n}`;
      const cfg: ServerCfg = { ...base, id };
      cfgs.push(cfg);
      return { ...cfg };
    },
    async remove(id) {
      if (!find(id)) return missing(id);
      const live = running.get(id) ?? 0;
      if (live > 0) return reject("serverBusy", `${live} ${live === 1 ? "run is" : "runs are"} live on this server. Stop them first.`);
      cfgs.splice(cfgs.findIndex((c) => c.id === id), 1);
      statuses.delete(id);
    },
    async probe(id) {
      if (!find(id)) return missing(id);
      await pause(stepMs);
      const s = { ...check(id), checkedAt: CHECKED_AT };
      publish(id, s);
      return s;
    },
    async setup(id, options) {
      if (!find(id)) return missing(id);
      const before = check(id);
      const done = (step: SetupStepName, state: SetupEvent["state"], message: string) => emit({ id, step, state, message });
      for (const { step, skip } of stepPlan(options, before)) {
        if (skip) {
          done(step, "skipped", skip);
          continue;
        }
        done(step, "started", STARTED[step]);
        await pause(stepMs);
        if (!before.reachable || failAt === step) {
          failAt = undefined;
          if (!before.reachable) done(step, "failed", before.error?.message ?? "The server is not reachable.");
          else done(step, "failed", `${STARTED[step]} failed: the command exited with status 1.`);
          publish(id, check(id));
          return;
        }
        if (step === "node") done(step, "info", "Downloading node-v24.13.0-linux-x64.tar.xz");
        done(step, "done", step === "probe" ? `${before.os}/${before.arch}, ${before.home}` : "Done");
      }
      publish(id, { ...READY, os: before.os, arch: before.arch, home: before.home, git: before.git, claude: before.claude.path ? before.claude : { path: "/home/me/.local/bin/claude", version: "2.1.4", loggedIn: null }, ready: true });
    },
    async repos(id, repoIds) {
      const s = find(id);
      if (!s) return missing(id);
      await pause(stepMs / 2);
      return repoIds.map((rid): RepoState => {
        const name = rid;
        const path = `${s.root}/${name}`;
        const there = (id === "build-server" && sum(rid) % 3 !== 0) || cloned.get(id)?.has(rid) === true;
        return there ? { name, path, exists: true, isGit: true, branch: sum(rid) % 2 === 0 ? "main" : "develop", dirty: sum(rid) % 4 === 0, origin: `git@example.com:acme/${name}.git` } : { name, path, exists: false, isGit: false };
      });
    },
    async clone(id, repoId) {
      if (!find(id)) return missing(id);
      await pause(stepMs);
      if (!check(id).reachable) return reject("unreachable", "The server is not reachable.");
      cloned.set(id, new Set([...(cloned.get(id) ?? []), repoId]));
    },
    async sshCommand(id) {
      const s = find(id);
      if (!s) return missing(id);
      return s.port ? `ssh -p ${s.port} ${s.destination}` : `ssh ${s.destination}`;
    },
    onSetup(cb) {
      setupSubs.add(cb);
      return () => void setupSubs.delete(cb);
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => void statusSubs.delete(cb);
    },
  };
}
