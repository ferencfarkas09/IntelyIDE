// The shapes of the `deeppattern_*` commands (`crates/deeppattern`), carried by hand like the Sentry ones.

export interface DpCommands {
  /** Gets the sources into ~/decision-engine and runs the installer, from any folder. */
  install: string;
  /** The installer's activation step: it asks for the endpoint and the key in its own masked window. */
  activate: string;
  /** The engine's own health check. */
  doctor: string;
}

export interface DpStatus {
  installed: boolean;
  /** An endpoint and a device credential are in the engine's config; the check is the proof. */
  activated: boolean;
  /** The host name of the endpoint, never the endpoint or a credential. */
  endpointHost?: string | null;
  /** A half-finished activation that the installer asks to be recovered by hand. */
  recoveryRequired: boolean;
  root: string;
  /** A check script is there to run. */
  doctor: boolean;
  commands: DpCommands;
}

export type DpVerdict = "pass" | "warn" | "fail" | "error";
export type DpTone = "ok" | "warn" | "fail" | "info";

export interface DpLine {
  tone: DpTone;
  text: string;
}

export interface DpReport {
  verdict: DpVerdict;
  exitCode?: number | null;
  lines: DpLine[];
  tookMs: number;
}
