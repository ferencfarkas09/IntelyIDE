import type { AgentEffective, EnforcementChip, ProviderCaps } from "@intely/protocol";
import type { DoctorFinding, ProviderInfo as BoundProviderInfo, ProviderStateChange, ProviderTest as BoundProviderTest } from "../bindings/settings";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";
import { capsOfProvider } from "./providerCaps";

export type { AuthModeInfo, CliDetection, DoctorFinding, DoctorLevel, LaunchInfo, LaunchStatus, ProviderHost, ProviderKind, ProviderState, ProviderStateChange } from "../bindings/settings";
export type ProviderInfo = BoundProviderInfo;
export type ProviderTest = BoundProviderTest;

/**
 * What the attempt suites say about one provider for one kind of role. `chip.run` is absent when no suite ever ran, which is
 * the normal state of every adapter but Claude. The tier is computed by the backend from recorded runs and cannot be set.
 */
export interface ProviderEnforcement {
  provider: string;
  /** `write` stands for every mode that can change files or run commands (edit, ask). */
  roleMode: "readOnly" | "write";
  chip: EnforcementChip;
}

/** Capabilities of a provider and where they come from: `runtime` after a session negotiated them, `static` for the documented defaults. */
export interface ProviderCapsReport {
  caps: ProviderCaps;
  source: "runtime" | "static";
}

/**
 * What a Test run found out ((design notes: providers-plan) 2.3): one session opened read-only in an empty scratch directory, what the adapter
 * reported, then closed. No prompt is sent, so no model is called, nothing can be edited and nothing is stored.
 */
export interface ProbeReport {
  provider: string;
  ok: boolean;
  model?: string | null;
  /** What the session reported at start; absent when it reported none. */
  caps?: ProviderCaps | null;
  /** `caps` came from the running session (false: only the documented defaults exist). */
  negotiated: boolean;
  effective?: AgentEffective | null;
  error?: string | null;
  ms: number;
}

export interface ProvidersIpc {
  /** From the backend's cache: starts no process and asks no Keychain. A fresh run shows enabled providers as `probing`. */
  list(): Promise<ProviderInfo[]>;
  /** Looks for installed CLIs on the login-shell PATH (with versions); does not change settings. Call when Settings > Providers opens. */
  detect(): Promise<ProviderInfo[]>;
  /** A cheap probe (`--version` plus key presence), never a billed completion. */
  test(id: string): Promise<ProviderTest>;
  setEnabled(id: string, enabled: boolean): Promise<ProviderInfo>;
  /** `id` is one of the provider's `authModes`; rejects with `invalidAuthMode` otherwise. */
  setAuthMode(id: string, mode: string): Promise<ProviderInfo>;
  /** Re-detects, then reports CLI state and stray credential variables (names only). */
  doctor(): Promise<DoctorFinding[]>;
  /** Recorded enforcement results per provider and role kind; a provider that is missing here has never run a suite (weak). */
  enforcement(): Promise<ProviderEnforcement[]>;
  /** The capability matrix for the popover: negotiated when known, else the documented defaults. Starts nothing. */
  caps(id: string): Promise<ProviderCapsReport>;
  /** The global `Experimental providers` switch (default off, remembered). Every provider but Claude needs it. */
  experimental(): Promise<boolean>;
  setExperimental(on: boolean): Promise<boolean>;
  /**
   * The user confirmed this exact command line (shown in full). The program is an absolute path; a provider with a fixed proposal
   * takes exactly its arguments. Rejects with `invalidLaunch`. Stored with a hash: a changed line asks again.
   */
  confirmLaunch(id: string, command: string, args: string[]): Promise<ProviderInfo>;
  revokeLaunch(id: string): Promise<ProviderInfo>;
  /**
   * Settings > Safety: lets one provider run roles that change files below the write tier. Turning it on needs the provider id typed
   * (`typed`); rejects with `confirmationRequired` otherwise. Off needs nothing.
   */
  setWeakWriter(id: string, allow: boolean, typed?: string): Promise<ProviderInfo>;
  /** The Test run: negotiated capabilities without a prompt (see `ProbeReport`). */
  testRun(id: string, model?: string): Promise<ProbeReport>;
  onState(cb: (e: ProviderStateChange) => void): Unsubscribe;
}

export function createTauriProviders(): ProvidersIpc {
  return {
    list: () => call("providers_list"),
    detect: () => call("providers_detect"),
    test: (id) => call("providers_test", { id }),
    setEnabled: (id, enabled) => call("providers_set_enabled", { id, enabled }),
    setAuthMode: (id, mode) => call("providers_set_auth_mode", { id, mode }),
    doctor: () => call("providers_doctor"),
    // Not every build of the backend has these two commands yet; a missing one means "nothing recorded" / "documented defaults".
    enforcement: () => call<ProviderEnforcement[]>("providers_enforcement").catch(() => []),
    caps: (id) => call<ProviderCaps>("providers_caps", { id }).then((caps) => ({ caps, source: "runtime" as const }), () => ({ caps: capsOfProvider(id), source: "static" as const })),
    experimental: () => call("providers_experimental_get"),
    setExperimental: (on) => call("providers_experimental_set", { on }),
    confirmLaunch: (id, command, args) => call("providers_confirm_launch", { id, command, args }),
    revokeLaunch: (id) => call("providers_revoke_launch", { id }),
    setWeakWriter: (id, allow, typed) => call("providers_set_weak_writer", { id, allow, typed }),
    testRun: (id, model) => call("providers_test_run", { id, model }),
    onState: (cb) => subscribe<ProviderStateChange>("providers:state", cb),
  };
}
