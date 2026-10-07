// Backend of the Cloudflare relay tools (`relay_cloud_*` commands, (design notes: remote-cloudflare-spec) 4.11): the commands in the app,
// a deterministic fixture in a plain browser, and `setCloudApi()` for tests (the checks/api.ts pattern). The fixture never
// touches a network or a process; `?cloud=fresh|deployed|readonly|custom|stale` picks a scenario for screenshots.
import type { Unsubscribe } from "../../../ipc";
import { call, subscribe } from "../../../ipc/rpc";
import { inTauri } from "../../l10n/api";
import type { CloudApi, CloudPlan, CloudRun, CloudView, DeployPreview, ErrorCode, Jail, LimitsNotice, LimitsRow, LogChunk, RelayCheck, RelayMode, StepName, StepStatus, WhoAmI } from "./types";
import { DEPLOY_STEPS } from "./types";

// The Rust side answers in its own shapes (relay_cloud.rs): a bare `{ runId }` for a started job, flat `relay-cloud:state` events
// and `secretStore`/`kitDirty` names. These adapters turn them into the UI contract of types.ts.
interface RawRun {
  runId: string;
  op: string;
  status: CloudRun["status"];
  step?: StepName | null;
  stepStatus?: StepStatus | null;
  code?: ErrorCode | null;
  detail?: string | null;
  loginUrl?: string | null;
}
const accum = new Map<string, CloudRun>();

export function reduceRun(raw: RawRun): CloudRun {
  const prev = accum.get(raw.runId);
  const run: CloudRun = prev ?? { runId: raw.runId, op: raw.op, status: "running", steps: [], error: null, loginUrl: null };
  run.op = raw.op || run.op;
  run.status = raw.status;
  if (raw.step) {
    if (run.steps.length === 0) run.steps = DEPLOY_STEPS.map((step) => ({ step, status: "pending" as StepStatus }));
    const row = run.steps.find((r) => r.step === raw.step);
    if (row && raw.stepStatus) {
      row.status = raw.stepStatus;
      if (raw.code) row.code = raw.code;
      else delete row.code;
    }
  }
  if (raw.loginUrl) run.loginUrl = raw.loginUrl;
  if (raw.status === "failed" || raw.status === "cancelled") {
    const code = (raw.code ?? (raw.status === "cancelled" ? "cancelled" : "deployFailed")) as ErrorCode;
    run.error = { code, tail: raw.detail ? raw.detail.split("\n") : [] };
  }
  if (raw.status === "running") accum.set(raw.runId, run);
  else accum.delete(raw.runId);
  return structuredClone(run);
}

async function started(cmd: string, args?: Record<string, unknown>): Promise<CloudRun> {
  const r = await call<{ runId: string }>(cmd, args);
  const known = accum.get(r.runId);
  return known ? structuredClone(known) : { runId: r.runId, op: cmd.replace("relay_cloud_", ""), status: "running", steps: [], error: null, loginUrl: null };
}

type RawView = Omit<CloudView, "secretStoreDurable" | "workersSubdomain" | "updateAvailable" | "interrupted"> &
  Partial<Pick<CloudView, "secretStoreDurable" | "workersSubdomain" | "updateAvailable" | "interrupted">> & { secretStore?: { durable: boolean } };

interface RustLimitRow {
  id: string;
  freePerDay: number | null;
  paidIncludedPerMonth: number | null;
}
interface RustLimits {
  checkedOn: string;
  rows: RustLimitRow[];
}

/** `limits.rs` sends one row per figure; the notice shows the grouped rows of types.ts (millions for the paid per-month counts). */
export function limitsView(l: RustLimits | LimitsNotice, now = Date.now()): LimitsNotice {
  if (!l.rows.length || "key" in l.rows[0]) return l as LimitsNotice;
  const by = new Map((l.rows as RustLimitRow[]).map((r) => [r.id, r]));
  const f = (id: string) => by.get(id)?.freePerDay ?? 0;
  const p = (id: string, div = 1) => (by.get(id)?.paidIncludedPerMonth ?? 0) / div;
  const rows: LimitsRow[] = [
    { key: "workerRequests", free: [f("workerRequests")], paid: [p("workerRequests", 1e6)] },
    { key: "doRequests", free: [f("doRequests")], paid: [p("doRequests", 1e6)] },
    { key: "doDuration", free: [f("doDuration")], paid: [p("doDuration")] },
    { key: "sqlRows", free: [f("sqliteRowsWritten"), f("sqliteRowsRead")], paid: [p("sqliteRowsWritten", 1e6), p("sqliteRowsRead", 1e6)] },
    { key: "sqlStorage", free: [f("sqliteStorage")], paid: [p("sqliteStorage")] },
    { key: "assets", free: [f("staticAssetFiles")], paid: [p("staticAssetFiles")] },
    { key: "websocket", free: [f("websocketIncomingRatio")], paid: [p("websocketIncomingRatio")] },
  ];
  const age = Math.max(0, Math.floor((now - new Date(l.checkedOn).getTime()) / 86_400_000));
  return { checkedOn: l.checkedOn, staleDays: Number.isFinite(age) ? age : 0, rows };
}

export function normalizeView(v: RawView): CloudView {
  const { secretStore, ...rest } = v;
  return {
    ...rest,
    kit: { ...rest.kit, dirtyFiles: rest.kit.dirtyFiles ?? 0 },
    secretStoreDurable: rest.secretStoreDurable ?? secretStore?.durable ?? true,
    workersSubdomain: rest.workersSubdomain ?? null,
    limits: limitsView(rest.limits),
    updateAvailable: rest.updateAvailable ?? false,
    interrupted: rest.interrupted ?? false,
  };
}

const tauriApi: CloudApi = {
  status: () => call<RawView>("relay_cloud_status").then(normalizeView),
  prepare: () => started("relay_cloud_prepare"),
  login: (device) => started("relay_cloud_login", { device }),
  logout: () => started("relay_cloud_logout"),
  tokenSet: (token) => call("relay_cloud_token_set", { token }),
  tokenClear: () => call("relay_cloud_token_clear"),
  whoami: () => call("relay_cloud_whoami"),
  chooseAccount: (accountId) => call("relay_cloud_choose_account", { accountId }),
  preview: (args) =>
    call<DeployPreview & { kitDirty?: number | null }>("relay_cloud_preview", { ...args, customDomain: null }).then((p) => ({ ...p, kitDirtyFiles: p.kitDirtyFiles ?? p.kitDirty ?? 0 })),
  plan: ({ op, previewId }) => call<CloudPlan>("relay_cloud_plan", { op, previewId: previewId ?? null }),
  deploy: (args) =>
    started("relay_cloud_deploy", {
      previewId: args.previewId,
      confirmName: args.confirmName,
      overwritePhrase: args.overwritePhrase ?? null,
      planId: args.planId,
      acknowledgeUnverified: args.acknowledgeUnverified ?? false,
    }),
  stop: (runId) => call("relay_cloud_stop", { runId }),
  logs: (runId, fromSeq) => call("relay_cloud_logs", { runId, fromSeq }),
  verify: (args) => call("relay_cloud_verify", { target: args.target, url: args.url ?? null, pubkey: args.pubkey ?? null }),
  apply: ({ mode, confirmUnpair }) => (mode === "custom" ? call("relay_cloud_custom_apply", { confirmUnpair }) : call("relay_cloud_apply", { mode, confirmUnpair })).then(() => undefined),
  customSet: (args) => call("relay_cloud_custom_set", { url: args.url, pubkey: args.pubkey ?? null, acknowledgeHost: args.acknowledgeHost }),
  rollback: (confirmName, planId) => started("relay_cloud_rollback", { confirmName, planId }),
  forget: (confirm) => call("relay_cloud_forget", { confirm }),
  rotate: (kind, confirm) => call("relay_cloud_rotate", { kind, confirm }),
  remove: (confirmName, planId) => started("relay_cloud_remove", { confirmName, planId }),
  onState: (cb): Unsubscribe => subscribe<RawRun>("relay-cloud:state", (raw) => cb(reduceRun(raw))),
  onLog: (cb): Unsubscribe => subscribe<LogChunk>("relay-cloud:log", cb),
};

let override: CloudApi | undefined;
export const setCloudApi = (api: CloudApi | undefined): void => void (override = api);

let mock: CloudApi | undefined;
export function cloudApi(): CloudApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockCloud(scenarioFromUrl()));
}

export interface MockCloudOptions {
  jail?: Jail;
  mode?: RelayMode;
  kitFound?: boolean;
  /** node and pnpm are not on the app's PATH (false); default true. */
  toolsOk?: boolean;
  wranglerOk?: boolean;
  distBuilt?: boolean;
  dirtyFiles?: number;
  durable?: boolean;
  subdomain?: string | null;
  loggedIn?: boolean;
  accounts?: { id: string; name: string }[];
  nameCheck?: DeployPreview["nameCheck"];
  /** Start with a deployed relay. */
  deployed?: boolean;
  failAt?: { step: StepName; code: ErrorCode };
  /** Milliseconds between scripted steps (0 in tests: timers only). */
  stepDelay?: number;
  /** The sign-in finishes only when the test calls `sim.finishLogin()`. */
  holdLogin?: boolean;
  removeEnabled?: boolean;
  updateAvailable?: boolean;
  interrupted?: boolean;
  custom?: Partial<RelayCheck>;
  staleCheck?: boolean;
  /** The dry run could not read the bundled module list (the review needs an acknowledgement). */
  unverifiedModules?: boolean;
  /** A rotated key is staged. */
  rotationPending?: boolean;
}

export interface MockCloudSim {
  calls: string[];
  view: CloudView;
  finishLogin(): void;
  /** Every argument object passed to a call, by name (for "the token never appears in argv" style checks). */
  args: Record<string, unknown[]>;
}

const NOW = () => Math.floor(Date.now() / 1000);
const LIMITS = {
  checkedOn: "2026-10-04",
  staleDays: 0,
  rows: [
    { key: "workerRequests", free: [100_000], paid: [10] },
    { key: "doRequests", free: [100_000], paid: [1] },
    { key: "doDuration", free: [13_000], paid: [400_000] },
    { key: "sqlRows", free: [100_000, 5_000_000], paid: [50, 25_000] },
    { key: "sqlStorage", free: [5], paid: [10] },
    { key: "assets", free: [20_000], paid: [100_000] },
    { key: "websocket", free: [20], paid: [20] },
  ],
} as const;

export function createMockCloud(opts: MockCloudOptions = {}): CloudApi & { sim: MockCloudSim } {
  const delay = opts.stepDelay ?? 0;
  const stateCbs = new Set<(r: CloudRun) => void>();
  const logCbs = new Set<(c: LogChunk) => void>();
  const logs = new Map<string, string[]>();
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  const accounts = opts.accounts ?? [{ id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Demo Gastro" }];
  let runCounter = 0;
  let previewCounter = 0;
  let live: { preview: DeployPreview | null } = { preview: null };
  /** Plans held by the fixture, as Rust holds them: single use, short expiry, bound to the operation. */
  const plans = new Map<string, CloudPlan>();
  let planCounter = 0;
  /** Unix seconds, like the Rust plan. */
  const nowSecs = () => Math.floor(Date.now() / 1000);
  /** The fixture's plan check: nonce known, not expired, right operation, typed name equal; spent by the run. */
  const redeem = (planId: string, op: CloudPlan["op"], typed: string): void => {
    const p = plans.get(planId);
    if (!p || p.op !== op || p.expiresAt <= nowSecs()) {
      plans.delete(planId);
      throw { code: "previewStale", message: "plan" };
    }
    if (typed !== p.workerName) throw { code: "confirmMismatch", message: "name" };
    plans.delete(planId);
  };
  let loginResolve: (() => void) | null = null;
  const cancelled = new Set<string>();

  const bundle = { hashShort: "a1b2 c3d4 e5f6 0718", hashFull: "a1b2c3d4e5f6071829384756a1b2c3d4e5f6071829384756a1b2c3d4e5f60718", pubFingerprint: "9f8e 7d6c 5b4a 3921", seq: 1_790_000_000, builtAt: NOW() - 3600 };
  const goodCheck = (): RelayCheck => ({ reachable: true, latencyMs: 84, relayVersion: "0.1.0", protocol: "intely.v1", doOk: true, pushConfigured: false, servedHash: bundle.hashFull, verdict: "ok", swMatches: true, checkedAt: NOW(), problems: [], ...(opts.custom ?? {}) });

  const view: CloudView = {
    jail: opts.jail ?? "off",
    kit: { found: opts.kitFound ?? true, wranglerVersion: opts.wranglerOk === false ? "4.100.0" : "4.147.0", wranglerPinned: "4.147.0", wranglerOk: opts.wranglerOk ?? true, nodeOk: opts.toolsOk ?? true, pnpmOk: opts.toolsOk ?? true, distBuilt: opts.distBuilt ?? true, distBuiltAt: NOW() - 7200, relayVersion: "0.1.0", dirtyFiles: opts.dirtyFiles ?? 0 },
    secretStoreDurable: opts.durable ?? true,
    workersSubdomain: opts.subdomain === undefined ? "example" : opts.subdomain,
    mode: opts.mode ?? (opts.deployed ? "cloudflare" : "local"),
    profile: opts.deployed
      ? { workerName: "intely-relay-3f9a1c7e5b20", accountName: accounts[0]?.name ?? null, accountIdTail: "8f90", authMode: "oauth", url: "wss://intely-relay-3f9a1c7e5b20.example.workers.dev", deployedAt: NOW() - 3 * 3600, versionId: "b7c1e2d4", customDomain: null }
      : null,
    custom: null,
    auth: { authMode: "oauth", tokenStored: false, last: opts.loggedIn ? whoami(true) : null, checkedAt: opts.loggedIn ? NOW() : null },
    keys: { signingKey: !!opts.deployed, signingFingerprint: opts.deployed ? bundle.pubFingerprint : null, vapid: false, vapidPublic: null, pushDeployed: false, signingRotationPending: opts.rotationPending ?? false, vapidRotationPending: false },
    bundle: opts.deployed ? { ...bundle, deployed: true } : null,
    lastCheck: opts.deployed ? { ...goodCheck(), checkedAt: opts.staleCheck ? NOW() - 3 * 86400 : NOW() - 600 } : null,
    limits: { ...LIMITS, rows: LIMITS.rows.map((r) => ({ key: r.key, free: [...r.free], paid: [...r.paid] })) },
    busy: null,
    removeEnabled: opts.removeEnabled ?? false,
    updateAvailable: opts.updateAvailable ?? false,
    interrupted: opts.interrupted ?? false,
  };

  function whoami(loggedIn: boolean, mode: "oauth" | "token" = "oauth", chosen: string | null = null): WhoAmI {
    return { loggedIn, authType: loggedIn ? mode : null, emailHint: loggedIn && mode === "oauth" ? "f***@h***.hu" : null, accounts: loggedIn ? accounts : [], chosenAccountId: loggedIn ? chosen ?? (accounts.length === 1 ? accounts[0].id : null) : null };
  }
  const rec = (name: string, ...a: unknown[]) => {
    calls.push(name);
    (args[name] ??= []).push(a);
  };
  const emitState = (r: CloudRun) => stateCbs.forEach((cb) => cb(structuredClone(r)));
  const emitLog = (runId: string, lines: string[]) => {
    const all = logs.get(runId) ?? [];
    const chunk: LogChunk = { runId, startSeq: all.length, lines, reset: false };
    logs.set(runId, all.concat(lines));
    logCbs.forEach((cb) => cb(chunk));
  };
  const wait = () => new Promise<void>((r) => setTimeout(r, delay));
  const guard = () => {
    if (view.jail === "readOnly") throw { code: "readOnly", message: "read-only" };
    if (view.busy) throw { code: "busy", message: view.busy.op };
  };
  const newRun = (op: string, steps: StepName[] = []): CloudRun => ({ runId: `run${++runCounter}`, op, status: "running", steps: steps.map((s) => ({ step: s, status: "pending" })), error: null, loginUrl: null });

  /** Drives a scripted run in the background; the caller gets the first snapshot. */
  function drive(run: CloudRun, script: { step?: StepName; lines: string[]; fail?: ErrorCode; loginUrl?: string; hold?: () => Promise<void> }[], done?: () => void): CloudRun {
    view.busy = { runId: run.runId, op: run.op };
    void (async () => {
      await wait();
      for (const part of script) {
        if (cancelled.has(run.runId)) break;
        const st = part.step ? run.steps.find((s) => s.step === part.step) : undefined;
        if (st) st.status = "running";
        if (part.loginUrl) run.loginUrl = part.loginUrl;
        emitState(run);
        emitLog(run.runId, part.lines);
        if (part.hold) await part.hold();
        await wait();
        if (cancelled.has(run.runId)) break;
        const code = part.fail ?? (st && opts.failAt?.step === st.step ? opts.failAt.code : undefined);
        if (code) {
          if (st) {
            st.status = "failed";
            st.code = code;
          }
          run.steps.forEach((s) => s.status === "pending" && (s.status = "skipped"));
          run.status = "failed";
          run.error = { code, tail: logs.get(run.runId)?.slice(-20) ?? [] };
          view.busy = null;
          emitState(run);
          return;
        }
        if (st) st.status = "ok";
      }
      if (cancelled.has(run.runId)) {
        run.status = "cancelled";
        run.steps.forEach((s) => (s.status === "pending" || s.status === "running") && (s.status = "skipped"));
      } else {
        run.status = "ok";
        done?.();
      }
      view.busy = null;
      emitState(run);
    })();
    return structuredClone(run);
  }

  const api: CloudApi & { sim: MockCloudSim } = {
    sim: {
      calls,
      view,
      args,
      finishLogin: () => loginResolve?.(),
    },
    async status() {
      rec("status");
      return structuredClone(view);
    },
    async prepare() {
      rec("prepare");
      guard();
      const run = newRun("prepare");
      if (opts.toolsOk === false) return drive(run, [{ lines: ["pnpm was not found on PATH"], fail: "toolMissing" }]);
      return drive(run, [{ lines: ["$ pnpm install --frozen-lockfile", "Packages: +212", "Done in 18.2s", "$ pnpm build", "built in 4.1s"] }], () => {
        view.kit.distBuilt = true;
        view.kit.distBuiltAt = NOW();
      });
    },
    async login(device) {
      rec("login", device);
      guard();
      const run = newRun("login");
      const hold = opts.holdLogin ? () => new Promise<void>((r) => (loginResolve = r)) : undefined;
      return drive(run, [{ lines: [device ? "$ wrangler login --device" : "$ wrangler login", "Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?client_id=<masked>&state=<masked>"], loginUrl: "https://dash.cloudflare.com/oauth2/auth?client_id=<masked>&state=<masked>", hold }, { lines: ["Successfully logged in."] }], () => {
        view.auth.last = whoami(true);
        view.auth.authMode = "oauth";
        view.auth.checkedAt = NOW();
      });
    },
    async logout() {
      rec("logout");
      guard();
      return drive(newRun("logout"), [{ lines: ["$ wrangler logout", "Successfully logged out."] }], () => {
        view.auth.last = null;
      });
    },
    async tokenSet(token) {
      rec("tokenSet");
      (args.tokenSetValue ??= []).push(token.length);
      guard();
      view.auth = { authMode: "token", tokenStored: true, last: whoami(true, "token", accounts.length === 1 ? accounts[0].id : null), checkedAt: NOW() };
    },
    async tokenClear() {
      rec("tokenClear");
      view.auth = { authMode: "oauth", tokenStored: false, last: null, checkedAt: null };
    },
    async whoami() {
      rec("whoami");
      guard();
      const w = whoami(!!view.auth.last?.loggedIn, view.auth.authMode, view.auth.last?.chosenAccountId ?? null);
      view.auth.last = w;
      view.auth.checkedAt = NOW();
      return structuredClone(w);
    },
    async chooseAccount(accountId) {
      rec("chooseAccount", accountId);
      if (view.auth.last) view.auth.last.chosenAccountId = accountId;
    },
    async preview({ workerName, push }) {
      rec("preview", workerName, push);
      guard();
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) throw { code: "nameInvalid", message: "name" };
      const acc = accounts.find((a) => a.id === view.auth.last?.chosenAccountId) ?? accounts[0];
      if (!view.auth.last?.loggedIn || !acc) throw { code: "notLoggedIn", message: "login" };
      if (!view.workersSubdomain) throw { code: "noSubdomain", message: "subdomain" };
      const p: DeployPreview = {
        previewId: `preview${++previewCounter}`,
        expiresAt: Date.now() + 15 * 60_000,
        argv: ["wrangler", "deploy", "--config", "<state>/relay-deploy/" + workerName + "/wrangler.jsonc", "--name", workerName, "--message", "intely-relay:7d1c9e0a"],
        envNames: ["CLOUDFLARE_ACCOUNT_ID", "WRANGLER_SEND_METRICS", "WRANGLER_OUTPUT_FILE_PATH", "WRANGLER_LOG_PATH", "NO_COLOR", "PATH", "HOME"],
        account: { name: acc.name, idTail: acc.id.slice(-4) },
        workerName,
        nameCheck: opts.nameCheck ?? "free",
        resources: [
          { kind: "worker", label: workerName },
          { kind: "durableObject", label: "Room", detail: "v1" },
          { kind: "durableObject", label: "JoinLimiter", detail: "v1" },
          { kind: "assets", label: "" },
          { kind: "routeWorkersDev", label: "" },
          ...(push ? ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"].map((label) => ({ kind: "secret", label })) : []),
        ],
        files: { count: 38, bytes: 612 * 1024 },
        bundle: { hashShort: bundle.hashShort, hashFull: bundle.hashFull, pubFingerprint: bundle.pubFingerprint, seq: bundle.seq + 1 },
        push,
        hostPreview: `${workerName}.${view.workersSubdomain}.workers.dev`,
        moduleCheck: opts.unverifiedModules ? "unverified" : "verified",
        needsUnverifiedAck: !!opts.unverifiedModules,
        signingKeyStaged: view.keys.signingRotationPending,
        vapidKeyStaged: view.keys.vapidRotationPending,
        kitDirtyFiles: view.kit.dirtyFiles,
        fileList: [
          { path: "index.html", size: 1840, sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0" },
          { path: "sw.js", size: 9120, sha256: "aa11bb22cc33dd44ee55ff6600778899aa11bb22cc33dd44ee55ff6600778899" },
          { path: "bundle.json", size: 4310, sha256: "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" },
        ],
        configText: `{\n  "name": "${workerName}",\n  "main": "src/index.ts",\n  "workers_dev": true\n}`,
      };
      live = { preview: p };
      return structuredClone(p);
    },
    async plan({ op, previewId }) {
      rec("plan", op, previewId);
      guard();
      const prof = view.profile;
      const p = live.preview;
      let worker: string;
      let argv: string[];
      if (op === "deploy") {
        if (!p || p.previewId !== previewId || p.expiresAt < Date.now()) throw { code: "previewStale", message: "stale" };
        worker = p.workerName;
        argv = p.argv;
      } else {
        if (!prof) throw { code: "previewStale", message: "no relay" };
        worker = prof.workerName;
        argv = ["wrangler", op === "remove" ? "delete" : "rollback", "--name", worker, "--config", `<state>/relay-deploy/${worker}/wrangler.jsonc`];
      }
      const plan: CloudPlan = {
        planId: `plan${++planCounter}`.padEnd(32, "0"),
        op,
        workerName: worker,
        accountIdTail: "8f90",
        argv,
        commandLine: argv.join(" "),
        cwd: `<state>/relay-deploy/${worker}`,
        envNames: ["CLOUDFLARE_ACCOUNT_ID", "PATH", "HOME"],
        expiresAt: nowSecs() + 300,
      };
      plans.set(plan.planId, plan);
      return structuredClone(plan);
    },
    async deploy({ previewId, confirmName, overwritePhrase, planId, acknowledgeUnverified }) {
      rec("deploy", previewId, confirmName, overwritePhrase, planId, acknowledgeUnverified);
      guard();
      const p = live.preview;
      if (!p || p.previewId !== previewId || p.expiresAt < Date.now()) throw { code: "previewStale", message: "stale" };
      if ((p.nameCheck === "foreign" || p.nameCheck === "unknown" || p.kitDirtyFiles > 0) && overwritePhrase !== `overwrite ${p.workerName}`) throw { code: "confirmMismatch", message: "phrase" };
      if (p.needsUnverifiedAck && !acknowledgeUnverified) throw { code: "moduleUnverified", message: "modules" };
      redeem(planId, "deploy", confirmName);
      live = { preview: null };
      const run = newRun("deploy", DEPLOY_STEPS.filter((s) => s !== "secrets" || p.push));
      const lines: Record<StepName, string[]> = {
        stage: ["Staging 38 files (612 KB)", "Signed bundle seq " + p.bundle.seq],
        config: ["Wrote wrangler.jsonc"],
        deploy: [`$ wrangler deploy --name ${p.workerName}`, "Total Upload: 118.41 KiB / gzip: 31.02 KiB", "Deployed " + p.workerName + " triggers", `  https://${p.hostPreview}`],
        parse: ["Target accepted: https://" + p.hostPreview],
        secrets: ["VAPID_PRIVATE_KEY set", "VAPID_PUBLIC_KEY set", "VAPID_SUBJECT set"],
        health: ["GET /api/status: 523 (waiting)", "GET /api/status: 200 version 0.1.0"],
        verify: ["bundle hash equals the staged hash", "signature valid", "sw.js matches"],
        record: ["Profile recorded"],
      };
      return drive(
        run,
        run.steps.map((s) => ({ step: s.step, lines: lines[s.step] })),
        () => {
          view.profile = { workerName: p.workerName, accountName: p.account.name, accountIdTail: p.account.idTail, authMode: view.auth.authMode, url: `wss://${p.hostPreview}`, deployedAt: NOW(), versionId: "c9d8e7f6", customDomain: null };
          view.bundle = { ...bundle, seq: p.bundle.seq, builtAt: NOW(), deployed: true };
          view.keys = { ...view.keys, signingKey: true, signingFingerprint: bundle.pubFingerprint, pushDeployed: p.push, signingRotationPending: false, vapidRotationPending: p.push ? false : view.keys.vapidRotationPending };
          view.lastCheck = goodCheck();
          view.updateAvailable = false;
        },
      );
    },
    async stop(runId) {
      rec("stop", runId);
      cancelled.add(runId);
      loginResolve?.();
    },
    async logs(runId, fromSeq) {
      rec("logs", runId, fromSeq);
      const all = logs.get(runId) ?? [];
      return { runId, startSeq: fromSeq, lines: all.slice(fromSeq), reset: false };
    },
    async verify({ target, url, pubkey }) {
      rec("verify", target, url, pubkey);
      guard();
      const c = target === "custom" && !pubkey ? { ...goodCheck(), verdict: "observed" as const } : goodCheck();
      view.lastCheck = c;
      return structuredClone(c);
    },
    async apply({ mode, confirmUnpair }) {
      rec("apply", mode, confirmUnpair);
      guard();
      view.mode = mode;
    },
    async customSet({ url, pubkey }) {
      rec("customSet", url, pubkey);
      guard();
      view.custom = { url, pubkey: pubkey ?? null, acknowledgedAt: NOW() };
    },
    async rollback(confirmName, planId) {
      rec("rollback", confirmName, planId);
      guard();
      redeem(planId, "rollback", confirmName);
      return drive(newRun("rollback"), [{ lines: ["$ wrangler rollback", "Rolled back to the previous version"] }]);
    },
    async forget(confirm) {
      rec("forget", confirm);
      if (confirm !== "forget") throw { code: "confirmMismatch", message: "forget" };
      view.profile = null;
      view.bundle = null;
      view.mode = "local";
    },
    async rotate(kind, confirm) {
      rec("rotate", kind, confirm);
      guard();
      if (confirm !== "rotate") throw { code: "confirmMismatch", message: "rotate" };
      const stage = kind === "signing" || kind === "vapid";
      if (kind.startsWith("signing")) view.keys.signingRotationPending = stage;
      else view.keys.vapidRotationPending = stage;
      view.updateAvailable = stage;
    },
    async remove(confirmName, planId) {
      rec("remove", confirmName, planId);
      guard();
      redeem(planId, "remove", confirmName);
      return drive(newRun("remove"), [{ lines: ["$ wrangler delete"] }], () => {
        view.profile = null;
        view.mode = "local";
      });
    },
    onState(cb) {
      stateCbs.add(cb);
      return () => void stateCbs.delete(cb);
    },
    onLog(cb) {
      logCbs.add(cb);
      return () => void logCbs.delete(cb);
    },
  };
  return api;
}

function scenarioFromUrl(): MockCloudOptions {
  const s = typeof window === "undefined" ? null : new URLSearchParams(window.location?.search).get("cloud");
  const base = { stepDelay: 450 };
  switch (s) {
    case "deployed":
      return { ...base, deployed: true, loggedIn: true, updateAvailable: true };
    case "readonly":
      return { ...base, deployed: true, jail: "readOnly" };
    case "stale":
      return { ...base, deployed: true, staleCheck: true, loggedIn: true };
    case "foreign":
      return { ...base, loggedIn: true, nameCheck: "foreign", dirtyFiles: 3 };
    case "kitmissing":
      return { ...base, kitFound: false, durable: false };
    default:
      return { ...base, distBuilt: false };
  }
}
