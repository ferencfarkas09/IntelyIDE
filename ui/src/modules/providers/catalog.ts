import type { PermissionMode } from "@intely/protocol";
import { t, type MessageKey } from "../../i18n";

const LOGIN_IDS = new Set(["claude", "codex", "gemini", "copilot", "opencode", "goose", "qwen", "acp"]);

/** How to sign in to a provider (what no detection can tell). Undefined for a provider without a hint. */
export const loginHint = (id: string): string | undefined => (LOGIN_IDS.has(id) ? t(`providers.login.${id}` as MessageKey) : undefined);

/** The IDE only ever launches the user's own, unmodified CLI and never reads its credential files. */
export const loginNote = (): string => t("providers.loginNote");

type MapKey = "claude" | "codex" | "gemini" | "copilot" | "loop" | "acp";
const MAP_OF: Record<string, MapKey> = { claude: "claude", codex: "codex", gemini: "gemini", copilot: "copilot", openai: "loop", ollama: "loop" };

/**
 * One line: what the abstract mode means for this provider ((design notes: providers-plan) 2.2). `automatic` and `bypass` exist on Claude and the
 * mock provider only (the roles table never offers them: a role's permission is a ceiling for delegates, three-valued); for them the
 * line is the mode's own explanation, and any other provider says it refuses them.
 */
export function permissionMeaning(provider: string, mode: PermissionMode): string {
  if (mode === "automatic" || mode === "bypass") return provider === "claude" || provider === "mock" ? t(`modes.${mode}.hint`) : t("providers.perm.auto");
  return t(`providers.perm.${MAP_OF[provider] ?? "acp"}.${mode}` as MessageKey);
}

/** Providers whose caps come from a generic ACP session rather than a dedicated adapter. */
export const GENERIC_ACP = new Set(["opencode", "goose", "qwen", "acp"]);

/** Short mark for a provider: two letters on a quiet tile, so the header never needs a brand asset. */
export const MARK: Record<string, string> = { claude: "Cl", codex: "Cx", gemini: "Ge", copilot: "Co", opencode: "Oc", goose: "Go", qwen: "Qw", acp: "Ac", openai: "Oa", ollama: "Ol", mock: "Mk" };
export const markOf = (id: string): string => MARK[id] ?? id.slice(0, 2).replace(/^./, (c) => c.toUpperCase());

/** Proper names: not translated. */
export const NAME: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", copilot: "GitHub Copilot", opencode: "OpenCode", goose: "Goose", qwen: "Qwen Code", acp: "ACP agent", openai: "OpenAI-compatible", ollama: "Ollama", mock: "Mock" };
export const providerName = (id: string): string => NAME[id] ?? id;
