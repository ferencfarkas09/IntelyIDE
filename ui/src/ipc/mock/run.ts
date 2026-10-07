import type { Catalog, LogChunk, ProcessAccess, ScriptGroup, ScriptInfo, ServerInfo } from "../run";
import type { RunIpc } from "../run";

const ESC = "\x1b[";
const c = (code: number, text: string) => `${ESC}${code}m${text}${ESC}0m`;

function script(name: string, group: ScriptGroup, extra: Partial<ScriptInfo> = {}, pm = "npm"): ScriptInfo {
  return { id: `npm:${name}`, name, source: "npm", group, safety: "normal", reasons: [], forbiddenToAgents: false, envNames: [], runner: `${pm} run ${name}`, ...extra };
}

const confirm = (reasons: string[]): Partial<ScriptInfo> => ({ safety: "confirm", reasons, forbiddenToAgents: true });

/** Shaped after the real repos (names and groups only; the mock never sees a body). */
const CATALOGS: Record<string, Omit<Catalog, "repoId">> = {
  backend: {
    packageManager: "npm",
    notes: [],
    scripts: [
      script("dev-local", "dev", { ...confirm(["process manager (pm2 / nodemon)"]), envNames: ["DOTENV_CONFIG_PATH", "NODE_ENV"] }),
      script("start", "start", confirm(["process manager (pm2 / nodemon)"])),
      script("test", "test"),
      script("test:integration", "test"),
      script("lint", "lint"),
      script("build", "build", confirm(["build: writes output and is heavy"])),
      script("migrate:task-hours-rates", "other", confirm(["changes data"])),
      script("update-server", "other", confirm(["remote or device command", "installs packages"])),
    ],
  },
  admin: {
    packageManager: "npm",
    notes: [],
    scripts: [
      script("start", "start", { heavyMb: 4800, portHint: 8082 }),
      script("start-local-web", "start", { heavyMb: 4800, portHint: 8082 }),
      script("open:src:web", "dev", { heavyMb: 4800, portHint: 8082 }),
      script("test", "test"),
      script("test:e2e", "test"),
      script("test:lambdatest:tunnel", "test", { envNames: ["LT_ACCESS_KEY", "LT_USERNAME"] }),
      script("lint", "lint"),
      script("lint:changed", "lint"),
      script("lint:docker", "lint", confirm(["uses Docker"])),
      script("build-web", "build", { ...confirm(["deletes files"]), heavyMb: 4800 }),
      script("publish:wrangler", "build", confirm(["deploys or publishes"])),
      script("login:wrangler", "other", confirm(["deploys or publishes", "stores credentials"])),
    ],
  },
  services: {
    packageManager: "npm",
    notes: [],
    scripts: [
      script("start", "start"),
      script("startw", "start"),
      script("web", "dev", { portHint: 19006 }),
      script("web:tauri", "dev", { portHint: 19006, envNames: ["HAPPY_BUILD_TARGET"] }),
      script("test", "test"),
      script("lint", "lint"),
      script("build-android-aab", "build", confirm(["deploys or publishes"])),
      script("android", "other"),
      script("ios", "other"),
    ],
  },
  pos: {
    packageManager: "npm",
    notes: ["Tauri devUrl http://localhost:8080 is served by tauri:web:dev."],
    scripts: [
      script("start", "start", { envNames: [] }),
      script("start2", "start"),
      script("dev", "dev", { portHint: 8080 }),
      script("tauri:web:dev", "dev", { heavyMb: 4096, portHint: 8080 }),
      script("tauri:dev", "dev"),
      script("test", "test"),
      script("lint", "lint"),
      script("build-mac", "build", confirm(["stores credentials", "deploys or publishes"])),
      script("login:github", "other", { ...confirm(["stores credentials"]), envNames: ["GH_TOKEN"] }),
      { ...script("cargo check", "lint"), id: "cargo:check", source: "cargo", runner: "cargo check --manifest-path src-tauri/Cargo.toml" },
      { ...script("cargo test", "test"), id: "cargo:test", source: "cargo", runner: "cargo test --manifest-path src-tauri/Cargo.toml" },
    ],
  },
};

/** What "Show command" returns in the mock: masked, env values replaced. */
const BODIES: Record<string, string> = {
  "pos:npm:login:github": "set GH_TOKEN=… && set GH_TOKEN=…",
  "admin:npm:open:src:web": "babel-node --max-old-space-size=4800 tools/srcWebServer.js",
  "pos:npm:tauri:web:dev": "babel-node --max-old-space-size=4096 tools/srcServerTauri.js",
};

interface Sim {
  info: ServerInfo;
  lines: string[];
  first: number;
  timers: ReturnType<typeof setTimeout>[];
  ticker?: ReturnType<typeof setInterval>;
}

/** A pretend dev server: it starts, prints coloured output, finds a port, grows a little and stops. No process exists. */
export function createMockRun(options: { jail?: "off" | "readOnly" } = {}): RunIpc {
  const jail = options.jail ?? (new URLSearchParams(globalThis.location?.search).get("jail") === "readOnly" ? "readOnly" : "off");
  let allowed = false;
  const sims = new Map<string, Sim>();
  const stateCbs = new Set<(s: ServerInfo) => void>();
  const logCbs = new Set<(c: LogChunk) => void>();
  let nextPort = 8082;

  const access = (): ProcessAccess => {
    const startable = jail === "off" || allowed;
    return { allowed, jail, startable, reason: startable ? null : 'Starting a process is refused in read-only mode. Turn on "Allow processes" in Settings > Safety to run dev servers for this session.' };
  };
  const pushState = (s: Sim) => stateCbs.forEach((cb) => cb(structuredClone(s.info)));
  const pushLines = (s: Sim, lines: string[]) => {
    const start = s.first + s.lines.length;
    s.lines.push(...lines);
    logCbs.forEach((cb) => cb({ serverId: s.info.id, startSeq: start, lines, reset: false }));
  };
  const later = (s: Sim, ms: number, fn: () => void) => void s.timers.push(setTimeout(fn, ms));

  function begin(s: Sim, scriptInfo: ScriptInfo): void {
    pushLines(s, [`─── ${scriptInfo.runner} ───`, c(2, `> ${scriptInfo.name}`), ""]);
    const port = scriptInfo.portHint ?? nextPort++;
    later(s, 250, () => pushLines(s, [c(36, "[webpack]") + " Compiling…", c(33, "warn") + "  Using the sandbox API (https://sandbox.example.test)"]));
    later(s, 700, () => {
      s.info = { ...s.info, status: "running", ports: [port], url: `http://localhost:${port}`, rssMb: scriptInfo.heavyMb ? 1800 : 420, procs: 4 };
      pushLines(s, [c(32, "Compiled successfully") + ` in 4.2s`, `  Local:   http://localhost:${port}/`, "  GH_TOKEN=***"]);
      pushState(s);
    });
    s.ticker = setInterval(() => {
      if (s.info.status !== "running") return;
      s.info = { ...s.info, rssMb: (s.info.rssMb ?? 400) + 12 };
      pushState(s);
      pushLines(s, [`${c(90, new Date().toISOString().slice(11, 19))} GET /api/orders ${c(32, "200")} 41ms`]);
    }, 2500);
  }

  function end(s: Sim, code: number): void {
    s.timers.forEach(clearTimeout);
    if (s.ticker) clearInterval(s.ticker);
    s.info = { ...s.info, status: "exited", exitCode: code, ports: [], url: null, rssMb: null, procs: 0, pid: null };
    pushLines(s, [`─── exited${code ? ` with code ${code}` : ""} ───`]);
    pushState(s);
  }

  const find = (repoId: string, id: string): ScriptInfo => {
    const found = CATALOGS[repoId]?.scripts.find((x) => x.id === id);
    if (!found) throw { code: "unknownScript", message: `the repo has no script ${id}` };
    return found;
  };

  return {
    async scripts(repoId) {
      const cat = CATALOGS[repoId];
      if (!cat) throw { code: "io", message: "the repo has no package.json or Cargo.toml" };
      return structuredClone({ repoId, ...cat });
    },
    async command(repoId, id) {
      find(repoId, id);
      return BODIES[`${repoId}:${id}`] ?? `${find(repoId, id).runner.replace(/^(npm|pnpm|yarn) run /, "")}`;
    },
    async start(req) {
      if (!access().startable) throw { code: "readOnly", message: access().reason };
      const info = find(req.repoId, req.script);
      if (info.safety === "confirm" && !req.confirmed) throw { code: "confirmRequired", message: `${info.runner} needs a confirmation: ${info.reasons.join(", ")}` };
      const id = `${req.repoId}:${req.script}`;
      if (sims.get(id)?.info.status === "running" || sims.get(id)?.info.status === "starting") throw { code: "alreadyRunning", message: `${info.runner} is already running` };
      const other = [...sims.values()].find((s) => s.info.id !== id && s.info.heavyMb && ["running", "starting"].includes(s.info.status));
      if (info.heavyMb && other && !req.allowSecondHeavy) {
        throw { code: "heavyRunning", message: `${other.info.runner} is a heavy server and is running; ${info.runner} needs up to ${info.heavyMb} MB of Node heap. Stop one of them first, or start anyway.` };
      }
      const previous = sims.get(id);
      const sim: Sim = previous ?? { info: {} as ServerInfo, lines: [], first: 0, timers: [] };
      sim.timers = [];
      sim.info = { id, repoId: req.repoId, script: req.script, runner: info.runner, status: "starting", pid: 40000 + sims.size, startedAt: Math.floor(Date.now() / 1000), ports: [], procs: 1, heavyMb: info.heavyMb ?? null, exitCode: null, url: null, rssMb: null };
      sims.set(id, sim);
      pushState(sim);
      begin(sim, info);
      return structuredClone(sim.info);
    },
    async stop(id) {
      const s = sims.get(id);
      if (!s || !["starting", "running"].includes(s.info.status)) return;
      s.info = { ...s.info, status: "stopping" };
      pushState(s);
      later(s, 400, () => end(s, 0));
    },
    async restart(id) {
      const s = sims.get(id);
      if (!s) throw { code: "io", message: `no server ${id}` };
      end(s, 0);
      const scriptId = s.info.script;
      return this.start({ repoId: s.info.repoId, script: scriptId, confirmed: true, allowSecondHeavy: true });
    },
    async stopAll() {
      for (const id of sims.keys()) await this.stop(id);
    },
    list: async () => [...sims.values()].map((s) => structuredClone(s.info)),
    async logs(id, fromSeq) {
      const s = sims.get(id);
      if (!s) throw { code: "io", message: `no server ${id}` };
      const start = Math.max(fromSeq, s.first);
      return { serverId: id, startSeq: start, lines: s.lines.slice(start - s.first), reset: false };
    },
    async clearLog(id) {
      const s = sims.get(id);
      if (!s) return;
      s.first += s.lines.length;
      s.lines = [];
      logCbs.forEach((cb) => cb({ serverId: id, startSeq: s.first, lines: [], reset: true }));
    },
    async dismiss(id) {
      if (sims.get(id)?.info.status === "exited") sims.delete(id);
    },
    async open() {},
    access: async () => access(),
    async allowProcesses(next) {
      allowed = next;
      if (!next && jail === "readOnly") await this.stopAll();
      return access();
    },
    onState(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    onLog(cb) {
      logCbs.add(cb);
      return () => logCbs.delete(cb);
    },
  };
}
