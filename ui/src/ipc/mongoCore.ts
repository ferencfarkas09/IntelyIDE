import type {
  AiCapabilities,
  CancelView,
  ConnectionView,
  DialogHandle,
  ForgetReport,
  HostKeyView,
  ImportPreview,
  ImportReport,
  LocalHit,
  ProfileDraft,
  ProfileInput,
  ProfileMeta,
  ProfileView,
  ResetReport,
  RunRequest,
  SecretKind,
  SecretsStatus,
  SessionSecrets,
  SshSpec,
  StudioStatus,
  TestReport,
  TestStep,
  UriParse,
  WindowView,
  ConnSpec,
} from "../bindings/mongo";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type {
  AiCapabilities,
  AiMode,
  AiPrefs,
  AllowedHost,
  AuthMechanism,
  CancelView,
  ConnSpec,
  ConnectionView,
  Diagnosis,
  DialogHandle,
  DialogKind,
  Domain,
  EffectiveLevel,
  Environment,
  ErrorClass,
  FieldProblem,
  ForgetReport,
  HostKeyStatus,
  HostKeyView,
  HostPort,
  ImportItem,
  ImportPreview,
  ImportReport,
  LocalHit,
  Note,
  Notice,
  PlanView,
  ProfileDraft,
  ProfileInput,
  ProfileMeta,
  ProfileView,
  ReadCommand,
  ReadPreference,
  ResetReport,
  RoleChip,
  RunRequest,
  SecretKind,
  SecretsStatus,
  SessionSecrets,
  SshSpec,
  StepId,
  StepState,
  StudioStatus,
  TestReport,
  TestStep,
  TlsRelax,
  Tunnel,
  TunnelState,
  UriParse,
  WindowView,
} from "../bindings/mongo";

/** One `mongo:test` event: a step of the test `testId` changed state (the stepper renders these as they arrive). */
export interface TestEvent {
  testId: string;
  step?: TestStep;
  /** What the engine sends: the whole step list and whether the test is over. */
  steps?: TestStep[];
  done?: boolean;
}

export interface ExportOptions {
  /** Default on: the SSH tunnel and proxy settings (never a secret). */
  includeTunnel: boolean;
  /** Default off: CA, certificate and key file paths. */
  includePaths: boolean;
}

export interface ResetOptions {
  /** Also delete the audit log. */
  auditToo: boolean;
}

/**
 * MongoDB Studio's Rust core (`crates/mongo`, Tauri glue in `src-tauri/src/modules/mongo.rs`). The module is a cargo feature
 * (`mongo-studio`, off by default) plus a master switch (off by default): in a lean build every command is missing and
 * `status()` answers `compiled: false`. Nothing here returns a connection string: `profileSave({uri})` is write-only.
 * The only thing `run` accepts is a `ReadCommand`: there is no write variant and no raw command. Documents arrive as
 * canonical Extended JSON strings (Int64 stays `{"$numberLong": "..."}`).
 * Rejections carry `mongoDisabled`, `mongoConfirm` (a safety setting is being lowered: type the profile name),
 * `mongoNoUri`, `mongoNotConnected`, `mongoRejected` (validator), `mongoParse`, `mongoCancelled`, `mongoServer`,
 * `mongoConnect`, `readOnly` / `testJail` (the IDE jails refuse the network), and since the connection manager:
 * `mongoNeedSecret` (the message carries `needs:` and the secret kinds missing for this destination), `mongoNeedsReview`
 * (the signature failed: save again), `mongoTunnel`, `mongoHostKey`, `mongoImport`, `mongoBusy` (a test is already running),
 * `mongoHandle` (a dialog handle is unknown, expired or used).
 * Exempt from the master switch (answer while Studio is off, open no socket and start no process): `status`, `setEnabled`,
 * `parseLiteral`, `profiles`, `profileSave`, `profileDelete`, `profileDuplicate`, `profileMeta`, `secretsStatus`, `resetAll`.
 * Secrets are write-only everywhere: a pasted string is parsed in Rust, the password stays in the draft vault and the
 * webview only sees `hasPassword` and a draft token.
 */
export interface MongoCoreIpc {
  /** `compiled: false` when the build has no Studio; never rejects for that reason. */
  status(): Promise<StudioStatus>;
  /** The master switch. Turning it off closes every pool, cancels running operations and drops every cursor. */
  setEnabled(enabled: boolean): Promise<StudioStatus>;
  /** Pure: a mongosh literal to canonical Extended JSON (for the query bar's lint). */
  parseLiteral(text: string): Promise<string>;
  profiles(): Promise<ProfileView[]>;
  profileSave(input: ProfileInput): Promise<ProfileView>;
  profileDelete(id: string): Promise<void>;
  profileDuplicate(id: string): Promise<ProfileView>;
  dismissNotices(): Promise<void>;
  /** Parses a pasted connection string; secrets go to the draft vault, bound to the parsed destination. */
  uriParse(uri: string): Promise<UriParse>;
  /** The masked rendering (`user:***@`) of a spec; never a password. */
  uriRender(spec: ConnSpec, id?: string, draft?: string): Promise<string>;
  /** Drops a draft-vault entry (also when the dialog closes). */
  draftDiscard(draft: string): Promise<void>;
  /** A legacy one-string profile as fields for review; nothing is saved until the user saves. */
  profileConvert(id: string): Promise<ProfileDraft>;
  /** Group, favourite and colour: no re-signing, no typed confirmation. */
  profileMeta(id: string, meta: ProfileMeta): Promise<ProfileView>;
  /** Stores (or with `null` clears) one secret under the CURRENT connection identity. */
  profileSecret(id: string, kind: SecretKind, value: string | null): Promise<ProfileView>;
  /** Where secrets live (Keychain, this session only, or nowhere) and which ones exist for the current destination. */
  secretsStatus(id?: string): Promise<SecretsStatus>;
  /** Connects and runs the role probe; the result is part of the view and always shown. `secrets` are typed at connect time (S9). */
  connect(id: string, secrets?: SessionSecrets): Promise<ConnectionView>;
  disconnect(id: string): Promise<void>;
  /**
   * Connect, probe, close: nothing is saved or kept. A failure is a report (`ok: false`), not a rejection. With a `testId`
   * the steps stream through `onTest` while it runs; `mongoBusy` when a test is already running.
   */
  test(input: ProfileInput, testId?: string): Promise<TestReport>;
  testCancel(testId: string): Promise<boolean>;
  /** Resolves the bastion with `ssh -G`, scans it and reports its host key (unknown, known or changed). */
  sshHostkey(ssh: SshSpec): Promise<HostKeyView>;
  /** Trusts a scanned key (the fingerprint must match a fresh scan). A changed key can never be trusted from here. */
  sshTrust(host: string, port: number, fingerprint: string): Promise<void>;
  /** Removes a saved key from the app-owned file after the host name was typed (a legitimately re-keyed server). */
  sshForget(host: string, port: number, typedHost: string): Promise<ForgetReport>;
  /** Rust opens the native open/save dialog itself; the webview never supplies or sees a path. `null` = cancelled. */
  dialogOpen(kind: "import"): Promise<DialogHandle | null>;
  dialogSave(kind: "export", suggestedName?: string): Promise<DialogHandle | null>;
  profilesExport(ids: string[], options: ExportOptions, handle: string): Promise<{ count: number }>;
  profilesImportPreview(handle: string): Promise<ImportPreview>;
  profilesImport(handle: string, selected: number[]): Promise<ImportReport>;
  /** Loopback 27017-27019 probe, only on a click. */
  detectLocal(): Promise<LocalHit[]>;
  /** Cheap file and PATH checks (Node, the Claude CLI, the transport script); starts no process. */
  aiCapabilities(): Promise<AiCapabilities>;
  /** Closes everything and deletes all profiles, secrets and app-owned files. Works while Studio is off. */
  resetAll(typedPhrase: string, options: ResetOptions): Promise<ResetReport>;
  /** Runs a read in the tab and returns its first window (50 rows by default). Replaces the tab's cursor. */
  run(req: RunRequest): Promise<WindowView>;
  /** Rows `[offset, offset + count)` of the tab's result; a `find` past the 1000-row window is re-run with `skip`. */
  window(tab: string, offset: number, count: number): Promise<WindowView>;
  cursorClose(tab: string): Promise<void>;
  /** Flag + `killOp` on our own operation; `maxTimeMS` is the backstop. */
  cancel(tab: string): Promise<CancelView>;
  onState(cb: (status: StudioStatus) => void): Unsubscribe;
  /** The stepper of `test(input, testId)`. */
  onTest(cb: (event: TestEvent) => void): Unsubscribe;
}

const lean: StudioStatus = { compiled: false, enabled: false, network: "full", connections: [], notices: [] };

export function createTauriMongoCore(): MongoCoreIpc {
  return {
    // A build without the feature has no `mongo_status` command: that is "not compiled", not an error.
    status: () => call<StudioStatus>("mongo_status").catch(() => lean),
    setEnabled: (enabled) => call("mongo_set_enabled", { enabled }),
    parseLiteral: (text) => call("mongo_parse_literal", { text }),
    profiles: () => call("mongo_profiles"),
    profileSave: (input) => call("mongo_profile_save", { input }),
    profileDelete: (id) => call("mongo_profile_delete", { id }),
    profileDuplicate: (id) => call("mongo_profile_duplicate", { id }),
    dismissNotices: () => call("mongo_dismiss_notices"),
    uriParse: (uri) => call("mongo_uri_parse", { uri }),
    uriRender: (spec, id, draft) => call("mongo_uri_render", { spec, id, draft }),
    draftDiscard: (draft) => call("mongo_draft_discard", { draft }),
    profileConvert: (id) => call("mongo_profile_convert", { id }),
    profileMeta: (id, meta) => call("mongo_profile_meta", { id, meta }),
    profileSecret: (id, kind, value) => call("mongo_profile_secret", { id, kind, value }),
    secretsStatus: (id) => call("mongo_secrets_status", { id }),
    connect: (id, secrets) => call("mongo_connect", { id, secrets }),
    disconnect: (id) => call("mongo_disconnect", { id }),
    test: (input, testId) => call("mongo_test", { input, testId: testId ?? null }),
    testCancel: (testId) => call("mongo_test_cancel", { testId }),
    sshHostkey: (ssh) => call("mongo_ssh_hostkey", { ssh }),
    sshTrust: (host, port, fingerprint) => call("mongo_ssh_trust", { host, port, fingerprint }),
    sshForget: (host, port, typedHost) => call("mongo_ssh_forget", { host, port, typedHost }),
    dialogOpen: (kind) => call("mongo_dialog_open", { kind, suggestedName: null }),
    dialogSave: (kind, suggestedName) => call("mongo_dialog_save", { kind, suggestedName: suggestedName ?? null }),
    profilesExport: (ids, options, handle) => call<number | { count: number }>("mongo_profiles_export", { ids, includeTunnel: options.includeTunnel, includePaths: options.includePaths, handle }).then((r) => (typeof r === "number" ? { count: r } : r)),
    profilesImportPreview: (handle) => call("mongo_profiles_import_preview", { handle }),
    profilesImport: (handle, selected) => call("mongo_profiles_import", { handle, selected }),
    detectLocal: () => call("mongo_detect_local"),
    aiCapabilities: () => call("mongo_ai_capabilities"),
    resetAll: (typedPhrase, options) => call("mongo_reset_all", { typedPhrase, auditToo: options.auditToo }),
    run: (req) => call("mongo_run", { req }),
    window: (tab, offset, count) => call("mongo_window", { tab, offset, count }),
    cursorClose: (tab) => call("mongo_cursor_close", { tab }),
    cancel: (tab) => call("mongo_cancel", { tab }),
    onState: (cb) => subscribe<StudioStatus>("mongo:state", cb),
    onTest: (cb) => subscribe<TestEvent>("mongo:test", cb),
  };
}
