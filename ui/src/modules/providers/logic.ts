import type { ProviderEnforcement, ProviderInfo, ProviderKind, ProviderState } from "../../ipc/providers";
import { t, type MessageKey } from "../../i18n";
import { TIER_LABEL, TIER_TONE, tierFor } from "./enforcement";
import type { Tone } from "../../ui-kit";

const STATE_TONE: Record<ProviderState, Tone> = { off: "neutral", notInstalled: "warn", needsLogin: "warn", needsKey: "warn", needsConfirm: "warn", probing: "info", ready: "ok", throttled: "warn", offline: "warn", blocked: "danger", error: "danger" };

/** Label and tone per state; the label is a getter so it follows the language. */
export const STATE_CHIP = Object.fromEntries(
  (Object.keys(STATE_TONE) as ProviderState[]).map((state) => [state, { tone: STATE_TONE[state], get label() { return t(`providers.state.${state}` as MessageKey); } }]),
) as Record<ProviderState, { label: string; tone: Tone }>;

const AUTH_IDS = new Set(["subscription", "apiKey", "bedrock", "vertex", "chatgpt", "google", "cliLogin", "token", "configured", "oauth", "agent"]);

/** A sign-in mode's name in the current language; the backend's English label for a mode the UI does not know. */
export const authLabel = (mode: { id: string; label: string }): string => (AUTH_IDS.has(mode.id) ? t(`providers.auth.${mode.id}` as MessageKey) : mode.label);

export const kindLabel = (kind: ProviderKind): string => t(`providers.kind.${kind}` as MessageKey);

/** Key of the Keychain item that holds a provider's API key or token. */
export const secretKey = (providerId: string): string => `providers.${providerId}:default`;

export interface EnforcementChip {
  label: string;
  tone: Tone;
  detail: string;
}

/** One-line chip for places without the popover (tests, tooltips). The tier is computed from recorded suites, never configured ((design notes: providers-plan) 3.1). */
export function enforcementChip(p: Pick<ProviderInfo, "id" | "name" | "cli">, list: readonly ProviderEnforcement[]): EnforcementChip {
  const shown = tierFor(list, p.id, "write");
  const version = p.cli?.version ? ` ${p.cli.version}` : "";
  return {
    label: t("providers.enf.chip", { tier: TIER_LABEL[shown.tier] }),
    tone: TIER_TONE[shown.tier],
    detail: shown.tier === "weak" ? t("providers.enf.detailWeak", { name: p.name, version }) : t("providers.enf.detailPassed", { count: shown.passed.length, name: p.name, version }),
  };
}

/** Where the provider's endpoint lives; settings.json keeps it as `<id>.baseUrl` in the `providers` namespace. */
export const HAS_BASE_URL = new Set(["openai", "ollama"]);
export const baseUrlKey = (providerId: string): string => `${providerId}.baseUrl`;
export const BASE_URL_HINT: Record<string, string> = { openai: "https://api.openai.com/v1", ollama: "http://127.0.0.1:11434" };

export type BaseUrlProblem = "scheme" | "insecure" | "invalid";

/** https everywhere, plain http only for this machine. An empty value means "use the default". */
export function baseUrlProblem(raw: string): BaseUrlProblem | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "http:" && !local ? "insecure" : null;
}

export function replaceProvider(list: readonly ProviderInfo[], next: ProviderInfo): ProviderInfo[] {
  return list.map((p) => (p.id === next.id ? next : p));
}

export type SdkIssueCode = "sdk_missing" | "sdk_incompatible" | "sdk_unverified" | "sdk_broken";
export interface SdkIssue {
  code: SdkIssueCode;
  /** What the sidecar said after the stable prefix (paths are already masked there). */
  detail: string;
}

const SDK_PREFIX = /^(sdk_missing|sdk_incompatible|sdk_unverified|sdk_broken):\s*([\s\S]*)$/;
const SDK_CHIP_KEY: Record<SdkIssueCode, string> = { sdk_missing: "sdkMissing", sdk_incompatible: "sdkIncompatible", sdk_unverified: "sdkUnverified", sdk_broken: "sdkBroken" };

/**
 * The Claude Agent SDK problem the sidecar reports in `Detection.message` ((design notes: licensing-spec) section 6.4). The detection stays
 * `installed: true` when the CLI exists, so this is derived in the UI: it never turns into "not installed", and a provider that is
 * off or blocked by the org keeps its own state.
 */
export function sdkIssue(p: Pick<ProviderInfo, "id" | "state" | "message">): SdkIssue | null {
  if (p.id !== "claude" || p.state === "off" || p.state === "blocked" || !p.message) return null;
  const m = SDK_PREFIX.exec(p.message.trim());
  return m ? { code: m[1] as SdkIssueCode, detail: m[2].trim() } : null;
}

/** The chip a card shows: the SDK state when there is an SDK problem, else the backend state. */
export function cardChip(p: Pick<ProviderInfo, "id" | "state" | "message">): { label: string; tone: Tone } {
  const issue = sdkIssue(p);
  return issue ? { label: t(`providers.state.${SDK_CHIP_KEY[issue.code]}` as MessageKey), tone: "warn" } : STATE_CHIP[p.state];
}

/** The Resources folder of the app when its real place cannot be asked (a browser, a test): the usual drag-to-Applications install. */
export const DEFAULT_RESOURCES_DIR = "/Applications/IntelyIDE.app/Contents/Resources";

/** One shell word: single quotes, a quote inside the text closed and reopened. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The two commands that set the SDK up once. The installer ships inside the app (`sidecar/sdk-install.js`): `--plan` only prints what
 * would be downloaded, `--yes` downloads the pinned packages from registry.npmjs.org, checks every hash and the whole file tree
 * against the shipped list and installs it into the state folder. No npm, no scripts of the packages are run.
 */
export function sdkSetupCommands(resourcesDir: string): string[] {
  const installer = shellQuote(`${resourcesDir.replace(/\/+$/, "")}/sidecar/sdk-install.js`);
  return [`node ${installer} --plan`, `node ${installer} --yes`];
}
