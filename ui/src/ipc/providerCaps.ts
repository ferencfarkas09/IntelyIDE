import type { Cap, CapEntry, CapKey, ProviderCaps } from "@intely/protocol";

/**
 * Static capability defaults per provider ((design notes: providers-plan) 1.4). Runtime truth beats this table: a session's
 * `session.started` / ACP `initialize` computes the real `ProviderCaps`. Cells the plan marks *(unverified)* say so in the note.
 */
const c = (cap: Cap, note?: string): CapEntry => (note ? { cap, note } : { cap });

const base = (over: Partial<Record<CapKey, CapEntry>>, extra: Pick<ProviderCaps, "effortLevels" | "attachments">): ProviderCaps => ({
  streaming: c("yes"),
  toolEvents: c("yes"),
  permissions: c("partial"),
  resume: c("partial"),
  fork: c("no"),
  modelList: c("partial"),
  effort: c("partial"),
  subagents: c("no"),
  usage: c("partial"),
  hooks: c("no"),
  modelSwitch: c("partial"),
  cancel: c("yes"),
  sandbox: c("no"),
  ...over,
  ...extra,
});

const CLAUDE = base(
  {
    permissions: c("yes", "hook plus canUseTool"),
    resume: c("yes"),
    fork: c("yes"),
    modelList: c("yes"),
    effort: c("yes", "not offered on Haiku"),
    subagents: c("yes"),
    usage: c("yes", "client estimate, not billed on a subscription"),
    hooks: c("yes"),
    modelSwitch: c("yes"),
    sandbox: c("partial", "did not hold under bypass"),
  },
  { effortLevels: ["low", "medium", "high"], attachments: "files" },
);

const CODEX = base(
  {
    toolEvents: c("yes", "items; app-server vs ACP wrapper fidelity unverified"),
    permissions: c("yes", "requestApproval"),
    resume: c("yes"),
    fork: c("yes"),
    modelList: c("yes", "model/list"),
    effort: c("yes"),
    subagents: c("partial", "adapter"),
    usage: c("partial", "tokens only"),
    hooks: c("no", "rules files only"),
    modelSwitch: c("partial", "per turn"),
    sandbox: c("yes", "Seatbelt; credential denial unverified"),
  },
  { effortLevels: ["low", "medium", "high"], attachments: "images" },
);

const GEMINI = base(
  {
    permissions: c("partial", "the agent decides what to ask"),
    resume: c("partial", "loadSession; no fork"),
    modelList: c("partial", "config option, unstable switch"),
    effort: c("partial", "3 thinking levels"),
    usage: c("partial", "tokens; context over ACP"),
    hooks: c("partial", "BeforeTool exists in the CLI; under --acp unverified"),
    modelSwitch: c("partial", "unstable"),
    sandbox: c("yes", "optional Seatbelt"),
  },
  { effortLevels: ["low", "medium", "high"], attachments: "images" },
);

const COPILOT = base(
  {
    permissions: c("partial", "preview"),
    resume: c("partial", "unverified"),
    effort: c("partial", "server-level --effort"),
    subagents: c("partial", "SDK events"),
    usage: c("partial", "premium requests"),
    modelSwitch: c("no"),
    cancel: c("partial", "unverified over ACP"),
  },
  { effortLevels: ["low", "medium", "high"], attachments: "none" },
);

/** Another ACP agent (OpenCode, Goose, Qwen): everything beyond streaming and tool events is negotiated in `initialize`. */
const GENERIC_ACP = base(
  {
    permissions: c("partial", "negotiated at initialize"),
    resume: c("partial", "when the agent advertises loadSession"),
    modelList: c("partial", "config option list"),
    effort: c("partial", "thought_level config option, if offered"),
    usage: c("partial", "usage_update when sent"),
    cancel: c("partial", "session/cancel"),
  },
  { effortLevels: [], attachments: "none" },
);

const OPENAI = base(
  {
    permissions: c("yes", "every call goes through our router"),
    resume: c("partial", "emulated: replays our history"),
    fork: c("partial", "emulated"),
    modelList: c("yes", "/v1/models, thin metadata"),
    effort: c("partial", "reasoning models only"),
    usage: c("yes", "tokens (cost on OpenRouter)"),
    hooks: c("yes", "our router"),
    modelSwitch: c("yes", "per turn"),
    sandbox: c("partial", "ours, still to build"),
  },
  { effortLevels: ["low", "medium", "high"], attachments: "images" },
);

const OLLAMA: ProviderCaps = { ...OPENAI, effort: c("no", "local models have no effort control"), effortLevels: [], usage: c("partial", "tokens only") };

export const DEFAULT_CAPS: Record<string, ProviderCaps> = {
  claude: CLAUDE,
  codex: CODEX,
  gemini: GEMINI,
  copilot: COPILOT,
  opencode: GENERIC_ACP,
  goose: GENERIC_ACP,
  qwen: GENERIC_ACP,
  openai: OPENAI,
  ollama: OLLAMA,
};

/** Caps of a provider the table does not know: the conservative generic ACP row. */
export const capsOfProvider = (id: string): ProviderCaps => DEFAULT_CAPS[id] ?? GENERIC_ACP;
