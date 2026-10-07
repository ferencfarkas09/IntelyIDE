import type { Catalog, LogChunk, ProcessAccess, ServerInfo, StartRequest } from "../bindings/run";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type { Catalog, LogChunk, ProcessAccess, Safety, ScriptGroup, ScriptInfo, ServerInfo, ServerStatus, StartRequest } from "../bindings/run";

/**
 * The Scripts/Run panel's backend. Starting a process is a human action: nothing here is reachable from an agent. The webview
 * never sends a command line, only a repo id and a script id (`npm:dev`, `cargo:check`); the backend re-reads the manifest.
 * Script bodies never travel except through `command`, masked, when the user clicks "Show command". Rejections carry
 * `readOnly` (jail: turn on Allow processes), `testJail`, `confirmRequired`, `heavyRunning`, `alreadyRunning`, `unknownScript`.
 */
export interface RunIpc {
  scripts(repoId: string): Promise<Catalog>;
  /** The script body, secrets masked and inline env values replaced by an ellipsis. */
  command(repoId: string, script: string): Promise<string>;
  start(req: StartRequest): Promise<ServerInfo>;
  stop(serverId: string): Promise<void>;
  restart(serverId: string): Promise<ServerInfo>;
  stopAll(): Promise<void>;
  list(): Promise<ServerInfo[]>;
  /** Masked lines with `seq >= fromSeq` (ANSI kept). */
  logs(serverId: string, fromSeq: number): Promise<LogChunk>;
  clearLog(serverId: string): Promise<void>;
  /** Forgets an exited server and its log. */
  dismiss(serverId: string): Promise<void>;
  /** Opens the detected `http://localhost:<port>` in the system browser. */
  open(serverId: string): Promise<void>;
  /** What the jail says about starting a process (for a repo: the E2E fixture-root rule applies). */
  access(repoId?: string): Promise<ProcessAccess>;
  /** Settings > Safety, "Allow processes": in memory only, off at every launch. */
  allowProcesses(allowed: boolean): Promise<ProcessAccess>;
  onState(cb: (server: ServerInfo) => void): Unsubscribe;
  onLog(cb: (chunk: LogChunk) => void): Unsubscribe;
}

export function createTauriRun(): RunIpc {
  return {
    scripts: (repoId) => call("run_scripts", { repoId }),
    command: (repoId, script) => call("run_script_command", { repoId, script }),
    start: (req) => call("run_start", { req }),
    stop: (serverId) => call("run_stop", { serverId }),
    restart: (serverId) => call("run_restart", { serverId }),
    stopAll: () => call("run_stop_all"),
    list: () => call("run_list"),
    logs: (serverId, fromSeq) => call("run_logs", { serverId, fromSeq }),
    clearLog: (serverId) => call("run_clear_log", { serverId }),
    dismiss: (serverId) => call("run_dismiss", { serverId }),
    open: (serverId) => call("run_open", { serverId }),
    access: (repoId) => call("run_access", { repoId: repoId ?? null }),
    allowProcesses: (allowed) => call("run_allow_processes", { allowed }),
    onState: (cb) => subscribe<ServerInfo>("run:state", cb),
    onLog: (cb) => subscribe<LogChunk>("run:log", cb),
  };
}
