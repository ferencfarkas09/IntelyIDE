// Contract of the relay-on-your-own-Cloudflare UI ((design notes: remote-cloudflare-spec) 4.11). Rust sends codes and data only; the UI
// maps every `ErrorCode` to a `remote.cloud.err.<code>` string (logic.ts).

export type RelayMode = "local" | "cloudflare" | "custom";
export type Jail = "off" | "readOnly" | "e2e";
export type AuthMode = "oauth" | "token";

export const ERROR_CODES = [
  "readOnly", "testJail", "kitMissing", "toolMissing", "wranglerMissing", "wranglerVersion", "notLoggedIn", "needsAccount", "noSubdomain", "permission",
  "nameInvalid", "nameTaken", "confirmMismatch", "previewStale", "busy", "network", "timeout", "deployFailed", "secretFailed", "healthTimeout",
  "bundleMismatch", "badSignature", "hostNotAllowed", "needsRepair", "useApply", "keychain", "secretStoreVolatile", "authInvalid", "rateLimited",
  "accountUnverified", "loginPortBusy", "quota", "offline", "kitDirty", "seqClock", "cancelled", "moduleUnverified", "rotationPending", "rotationShipped", "auditCorrupt",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WhoAmI {
  loggedIn: boolean;
  authType: AuthMode | null;
  /** Masked by Rust (`f***@h***.hu`); the real address is never stored or sent. */
  emailHint: string | null;
  accounts: { id: string; name: string }[];
  chosenAccountId: string | null;
}

export type BundleVerdict = "ok" | "observed" | "hashMismatch" | "badSignature" | "keyMismatch" | "rollback" | "missing";

export interface RelayCheck {
  reachable: boolean;
  latencyMs: number | null;
  relayVersion: string | null;
  protocol: string | null;
  doOk: boolean | null;
  pushConfigured: boolean | null;
  servedHash: string | null;
  verdict: BundleVerdict;
  swMatches: boolean | null;
  /** Unix seconds. */
  checkedAt: number;
  problems: string[];
}

export interface LimitsRow {
  key: "workerRequests" | "doRequests" | "doDuration" | "sqlRows" | "sqlStorage" | "assets" | "websocket";
  /** Raw numbers from `limits.rs`; the words around them are ours (`remote.cloud.limits.<key>.free|paid`), the numbers go through `fmt.number`. */
  free: number[];
  paid: number[];
}
export interface LimitsNotice {
  /** ISO date the numbers were checked; formatted with `fmt.date`. */
  checkedOn: string;
  staleDays: number;
  rows: LimitsRow[];
}

export interface CloudView {
  jail: Jail;
  kit: {
    found: boolean;
    wranglerVersion: string | null;
    wranglerPinned: string;
    wranglerOk: boolean;
    nodeOk: boolean;
    pnpmOk: boolean;
    distBuilt: boolean;
    distBuiltAt: number | null;
    relayVersion: string | null;
    /** Uncommitted files in remote-relay and remote-web (read-only git status). */
    dirtyFiles: number;
  };
  /** False when the Keychain is degraded (4.12.9): nothing is generated then. */
  secretStoreDurable: boolean;
  /** The user's workers.dev subdomain label when known (`null` = not registered or unknown). */
  workersSubdomain: string | null;
  mode: RelayMode;
  profile: null | {
    workerName: string;
    accountName: string | null;
    accountIdTail: string | null;
    authMode: AuthMode;
    url: string;
    deployedAt: number | null;
    versionId: string | null;
    customDomain: string | null;
  };
  custom: null | { url: string; pubkey: string | null; acknowledgedAt: number };
  auth: { authMode: AuthMode; tokenStored: boolean; last: WhoAmI | null; checkedAt: number | null };
  keys: { signingKey: boolean; signingFingerprint: string | null; vapid: boolean; vapidPublic: string | null; pushDeployed: boolean; signingRotationPending: boolean; vapidRotationPending: boolean };
  bundle: null | { hashShort: string; hashFull: string; pubFingerprint: string; seq: number; builtAt: number; deployed: boolean };
  lastCheck: RelayCheck | null;
  limits: LimitsNotice;
  busy: null | { runId: string; op: string };
  removeEnabled: boolean;
  updateAvailable: boolean;
  /** The previous deploy never reported a result (app quit mid-run). */
  interrupted: boolean;
}

export interface DeployResource {
  kind: string;
  label: string;
  detail?: string;
}

/** The plan the Rust side holds for one deploy, rollback or remove (`relay_cloud_plan`): the exact command, its directory, the Worker
 *  name and a one-time nonce with a short expiry (`expiresAt`, Unix seconds). The UI shows this command and sends the nonce back. */
export interface CloudPlan {
  planId: string;
  op: "deploy" | "rollback" | "remove";
  workerName: string;
  accountIdTail: string;
  argv: string[];
  commandLine: string;
  cwd: string;
  envNames: string[];
  expiresAt: number;
}

export interface DeployPreview {
  previewId: string;
  expiresAt: number;
  argv: string[];
  envNames: string[];
  account: { name: string; idTail: string };
  workerName: string;
  nameCheck: "free" | "mine" | "foreign" | "unknown";
  /** Data, never a sentence: the UI words each `kind` itself (`remote.cloud.res.<kind>`); `detail` is a migration tag. */
  resources: DeployResource[];
  files: { count: number; bytes: number };
  bundle: { hashShort: string; hashFull: string; pubFingerprint: string; seq: number };
  push: boolean;
  hostPreview: string;
  kitDirtyFiles: number;
  /** The dry run could not read the bundled module list: deploying needs the user's acknowledgement (Rust refuses with `moduleUnverified`). */
  moduleCheck: "verified" | "unverified";
  needsUnverifiedAck: boolean;
  /** A rotated key is staged and this review signs with it (it becomes the active key only after the verified deploy). */
  signingKeyStaged: boolean;
  vapidKeyStaged: boolean;
  /** Full staged list (path, size, sha256), shown on request. */
  fileList: { path: string; size: number; sha256: string }[];
  configText: string;
}

export type StepName = "stage" | "config" | "deploy" | "parse" | "secrets" | "health" | "verify" | "record";
export const DEPLOY_STEPS: StepName[] = ["stage", "config", "deploy", "parse", "secrets", "health", "verify", "record"];
export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface CloudRun {
  runId: string;
  /** `login`, `logout`, `prepare`, `whoami`, `deploy`, `rollback`, `remove`, ... */
  op: string;
  status: "running" | "ok" | "failed" | "cancelled";
  steps: { step: StepName; status: StepStatus; code?: ErrorCode }[];
  error: null | { code: ErrorCode; tail: string[] };
  /** Sign-in URL printed by `wrangler login` (host `dash.cloudflare.com` only, enforced in Rust and again here). */
  loginUrl: string | null;
}

export interface LogChunk {
  runId: string;
  startSeq: number;
  lines: string[];
  reset: boolean;
}

export interface CloudApi {
  status(): Promise<CloudView>;
  prepare(): Promise<CloudRun>;
  login(device: boolean): Promise<CloudRun>;
  logout(): Promise<CloudRun>;
  tokenSet(token: string): Promise<void>;
  tokenClear(): Promise<void>;
  whoami(): Promise<WhoAmI>;
  chooseAccount(accountId: string): Promise<void>;
  preview(args: { workerName: string; push: boolean }): Promise<DeployPreview>;
  /** The plan (exact argv, directory, Worker name, one-time nonce) for a deploy of a live preview, or for a rollback / remove of the recorded Worker. */
  plan(args: { op: CloudPlan["op"]; previewId?: string }): Promise<CloudPlan>;
  deploy(args: { previewId: string; confirmName: string; overwritePhrase?: string; planId: string; acknowledgeUnverified?: boolean }): Promise<CloudRun>;
  stop(runId: string): Promise<void>;
  logs(runId: string, fromSeq: number): Promise<LogChunk>;
  verify(args: { target: "deployed" | "custom"; url?: string; pubkey?: string }): Promise<RelayCheck>;
  apply(args: { mode: RelayMode; confirmUnpair: boolean }): Promise<void>;
  customSet(args: { url: string; pubkey?: string; acknowledgeHost: string }): Promise<void>;
  rollback(confirmName: string, planId: string): Promise<CloudRun>;
  /** `confirm` is what the user typed (`forget`, `rotate`); Rust checks it again. */
  forget(confirm: string): Promise<void>;
  /** `signing` / `vapid` stage a new key; `signingCancel` / `vapidCancel` roll a pending rotation back. */
  rotate(kind: "signing" | "vapid" | "signingCancel" | "vapidCancel", confirm: string): Promise<void>;
  remove(confirmName: string, planId: string): Promise<CloudRun>;
  onState(cb: (run: CloudRun) => void): () => void;
  onLog(cb: (chunk: LogChunk) => void): () => void;
}
