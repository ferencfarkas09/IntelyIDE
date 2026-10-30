// Pure helpers of the Setup doctor: the agent checks from the provider state the app already keeps (no credential is
// read), the fix command of each check per platform, and the summary.
import type { ProviderInfo } from "../../ipc/providers";
import type { SetupCheck, SetupStatus } from "../../ipc/vibe";
import { sdkIssue } from "../providers/logic";

export type Platform = "mac" | "win" | "linux";

export const platform = (): Platform => {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Windows/i.test(ua) ? "win" : /Mac OS X|Macintosh/i.test(ua) ? "mac" : "linux";
};

/** One row of the panel: the probes of the backend plus the two agent rows. */
export interface DoctorRow extends SetupCheck {
  /** `sdk` and `login` come from the provider state. */
  source: "probe" | "agent";
}

/** The Agent SDK row and the Claude Code login row, read from Claude's provider state. */
export function agentRows(claude: Pick<ProviderInfo, "id" | "state" | "message"> | undefined): DoctorRow[] {
  const row = (id: string, status: SetupStatus, reason: string | null = null): DoctorRow => ({ id, status, version: null, path: null, reason, optional: false, source: "agent" });
  if (!claude) return [row("sdk", "notChecked", "unknown"), row("login", "notChecked", "unknown")];
  if (claude.state === "off") return [row("sdk", "warn", "claudeOff"), row("login", "notChecked", "claudeOff")];
  const issue = sdkIssue(claude);
  const sdk = issue ? row("sdk", issue.code === "sdk_missing" ? "missing" : "warn", issue.code) : row("sdk", "ok");
  const login =
    claude.state === "needsLogin" ? row("login", "missing")
    : claude.state === "ready" || claude.state === "throttled" ? row("login", "ok")
    : claude.state === "probing" ? row("login", "notChecked", "probing")
    : issue ? row("login", "notChecked", "sdkFirst")
    : row("login", "warn", claude.state);
  return [sdk, login];
}

/** The rows in panel order: the agent first (what blocks a run), then the tools. */
export const doctorRows = (probes: readonly SetupCheck[], claude: Pick<ProviderInfo, "id" | "state" | "message"> | undefined): DoctorRow[] => {
  const node = probes.filter((p) => p.id === "node").map((p): DoctorRow => ({ ...p, source: "probe" }));
  return [...node, ...agentRows(claude), ...probes.filter((p) => p.id !== "node").map((p): DoctorRow => ({ ...p, source: "probe" }))];
};

/** Whether the agent can start: Node, the SDK and the login are fine. */
export const agentReady = (rows: readonly DoctorRow[]): boolean => ["node", "sdk", "login"].every((id) => rows.find((r) => r.id === id)?.status === "ok");

export function summary(rows: readonly DoctorRow[]): { blocking: number; optional: number; ok: number } {
  const bad = rows.filter((r) => r.status === "missing" || r.status === "warn");
  return { blocking: bad.filter((r) => !r.optional).length, optional: bad.filter((r) => r.optional).length, ok: rows.filter((r) => r.status === "ok").length };
}

export interface Fix {
  /** Shown and copied as is. */
  command?: string;
  /** Safe to type into a terminal tab for the person (it still waits for Return). */
  runnable: boolean;
}

const brew = (pkg: string): Fix => ({ command: `brew install ${pkg}`, runnable: true });

/** The fix of a row on a platform; undefined when there is nothing to run (a link or a setting instead). */
export function fixOf(row: Pick<DoctorRow, "id" | "status" | "reason">, on: Platform, sdkCommands: readonly string[] = []): Fix | undefined {
  if (row.status === "ok" || row.status === "notChecked") return undefined;
  switch (row.id) {
    case "node":
      return on === "mac" ? (row.reason === "tooOld" ? { command: "brew upgrade node", runnable: true } : brew("node")) : on === "win" ? { command: "winget install OpenJS.NodeJS", runnable: true } : undefined;
    case "sdk":
      return sdkCommands.length && row.reason !== "claudeOff" ? { command: sdkCommands.join("\n"), runnable: false } : undefined;
    case "login":
      return row.status === "missing" ? { command: "claude", runnable: true } : undefined;
    case "git":
      return on === "mac" ? { command: "xcode-select --install", runnable: true } : on === "win" ? { command: "winget install Git.Git", runnable: true } : undefined;
    case "gh":
      return on === "mac" ? brew("gh") : on === "win" ? { command: "winget install GitHub.cli", runnable: true } : undefined;
    case "xcode":
      return on === "mac" ? { command: "xcode-select --install", runnable: true } : undefined;
    case "cocoapods":
      return on === "mac" ? brew("cocoapods") : undefined;
    case "android":
      // pointing ANDROID_HOME at the SDK means editing a startup file: shown to copy, never typed for the person
      return row.reason === "notConfigured" && on !== "win" ? { command: `export ANDROID_HOME="$HOME/${on === "mac" ? "Library/Android/sdk" : "Android/Sdk"}"\nexport PATH="$PATH:$ANDROID_HOME/platform-tools"`, runnable: false } : undefined;
    case "watchman":
      return on === "mac" ? brew("watchman") : undefined;
  }
  return undefined;
}
