import type { CliDetection, DoctorFinding, LaunchInfo, ProbeReport, ProviderEnforcement, ProviderInfo, ProviderState, ProviderStateChange, ProvidersIpc } from "../providers";
import { capsOfProvider } from "../providerCaps";
import type { EngineError } from "../../bindings";

interface Def {
  id: string;
  name: string;
  kind: ProviderInfo["kind"];
  /** Everything but Claude: needs the global switch and a confirmed command line. */
  experimental: boolean;
  modes: [id: string, label: string, needsKey: boolean][];
  /** What the mock "machine" has installed (matches the dev Mac: claude and codex). */
  installed?: string;
  /** The proposal; the program is the detected CLI. */
  args: string[];
  /** The user types the command line (custom ACP agent: nothing to detect). */
  editable?: boolean;
  /** The flags were run against the real program (only Codex's app-server was). */
  verified?: boolean;
}

// The providers that really exist in crates/settings/src/providers.rs, in the same order.
const DEFS: Def[] = [
  { id: "claude", name: "Claude", kind: "sdk", experimental: false, installed: "2.1.284", args: [], verified: true, modes: [["subscription", "Subscription (own CLI)", false], ["apiKey", "API key", true], ["bedrock", "Bedrock", false], ["vertex", "Vertex", false]] },
  { id: "codex", name: "Codex", kind: "cli", experimental: true, installed: "0.146.0", args: ["app-server"], verified: true, modes: [["chatgpt", "ChatGPT sign-in", false], ["apiKey", "API key", true]] },
  { id: "gemini", name: "Gemini", kind: "acp", experimental: true, args: ["--acp"], modes: [["google", "Google login", false], ["apiKey", "API key", true], ["vertex", "Vertex", false]] },
  { id: "copilot", name: "GitHub Copilot", kind: "acp", experimental: true, args: ["--acp", "--stdio"], modes: [["cliLogin", "CLI login", false], ["token", "Token", true]] },
  { id: "opencode", name: "OpenCode", kind: "acp", experimental: true, args: ["acp"], modes: [["cliLogin", "CLI login", false], ["apiKey", "API key", true]] },
  { id: "goose", name: "Goose", kind: "acp", experimental: true, args: ["acp"], modes: [["configured", "Configured in Goose", false]] },
  { id: "qwen", name: "Qwen Code", kind: "acp", experimental: true, args: ["--acp"], modes: [["oauth", "Qwen login", false], ["apiKey", "API key", true]] },
  { id: "acp", name: "ACP agent", kind: "acp", experimental: true, args: [], editable: true, modes: [["agent", "The agent's own login", false]] },
];

/** What the dev Mac has recorded: only Claude ran attempt suites (S0 to S2), every other adapter is untested and therefore weak. */
export const MOCK_ENFORCEMENT: ProviderEnforcement[] = (["readOnly", "write"] as const).map((roleMode) => ({
  provider: "claude",
  roleMode,
  chip: {
    tier: "bestEffort",
    run: {
      key: { adapter: "claude", authMode: "subscription", roleMode: roleMode === "write" ? "edit" : "readOnly", cliVersion: "2.1.284" },
      suites: { s0: "pass", s1: "pass", s2: "pass", s3: "notRun", s4: "notRun" },
      layersProven: ["denyRules", "hook"],
      at: Date.UTC(2026, 9, 3, 12, 0, 0),
    },
  },
}));

/** The chip a run of this provider and mode shows: the same table the providers list reads (one computation, like the Rust host). */
export const mockTier = (provider: string, readOnly: boolean): ProviderEnforcement["chip"]["tier"] => MOCK_ENFORCEMENT.find((e) => e.provider === provider && (e.roleMode === "readOnly") === readOnly)?.chip.tier ?? "weak";

function unknownProvider(id: string): EngineError {
  return { code: "unknownProvider", message: `unknown provider \`${id}\`` };
}

/** Not a cryptographic hash: the mock only needs a stable change detector. */
const mockHash = (command: string, args: string[]): string => {
  let h = 0xcbf29ce4;
  for (const c of `${command}\0${args.join("\0")}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(2);
};

interface Confirmed {
  command: string;
  args: string[];
  at: number;
}

/** Same state machine and error codes as the Rust registry; detection results are fixed. A mock key is never present. */
export function createMockProviders(keys: ReadonlySet<string> = new Set()): ProvidersIpc {
  const hasKey = (d: Def) => keys.has(`providers.${d.id}:default`);
  const enabled = new Map(DEFS.map((d) => [d.id, d.id === "claude"]));
  const modes = new Map(DEFS.map((d) => [d.id, d.modes[0][0]]));
  const detected = new Map<string, CliDetection>();
  const confirmed = new Map<string, Confirmed>();
  const weakWriter = new Set<string>();
  const negotiated = new Set<string>();
  let experimental = false;
  const listeners = new Set<(e: ProviderStateChange) => void>();

  const def = (id: string): Def => {
    const found = DEFS.find((d) => d.id === id);
    if (!found) throw unknownProvider(id);
    return found;
  };

  function launchOf(d: Def): LaunchInfo | undefined {
    if (!d.experimental) return undefined;
    const c = confirmed.get(d.id);
    if (c) return { command: c.command, args: c.args, resolved: true, editable: !!d.editable, verified: !!d.verified, status: "confirmed", confirmedAt: Math.floor(c.at / 1000), hash: mockHash(c.command, c.args) };
    const found = detected.get(d.id)?.path;
    return { command: found ?? (d.editable ? "" : d.id), args: d.args, resolved: !!found, editable: !!d.editable, verified: !!d.verified, status: "unconfirmed" };
  }

  /** What the CLI, the key and the confirmed line say, ignoring the switch. */
  function health(d: Def): [ProviderState, string | null] {
    const mode = d.modes.find((m) => m[0] === modes.get(d.id))!;
    const cli = detected.get(d.id);
    if (!d.editable) {
      if (!cli) return ["probing", "Not detected yet"];
      if (!cli.path) return ["notInstalled", `${cli.bin} was not found on PATH`];
    }
    if (mode[2]) {
      if (d.experimental) return ["needsLogin", "Key sign-in is not wired for runs yet: pick the login mode"];
      if (!hasKey(d)) return ["needsKey", `No ${mode[1].toLowerCase()} stored`];
    }
    if (d.experimental && launchOf(d)?.status !== "confirmed") return ["needsConfirm", d.editable ? "Enter the command line of the agent and confirm it" : "Confirm the command line the IDE will start"];
    return ["ready", null];
  }

  function info(d: Def): ProviderInfo {
    const mode = d.modes.find((m) => m[0] === modes.get(d.id))!;
    const cli = d.editable ? undefined : detected.get(d.id);
    const runs = enabled.get(d.id)! && (!d.experimental || experimental);
    const [state, message] = runs ? health(d) : (["off", null] as const);
    const launch = launchOf(d);
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      host: "sidecar",
      enabled: enabled.get(d.id)!,
      state,
      configured: d.editable ? launch?.status === "confirmed" : mode[2] ? hasKey(d) : !!cli?.path,
      authModes: d.modes.map(([id, label, needsKey]) => ({ id, label, needsKey })),
      authMode: mode[0],
      experimental: d.experimental,
      hasKey: mode[2] && hasKey(d),
      ...(cli ? { cli: structuredClone(cli) } : {}),
      ...(launch ? { launch } : {}),
      allowWeakWriter: weakWriter.has(d.id),
      ...(message ? { message } : {}),
    };
  }

  const states = () => new Map(DEFS.map((d) => [d.id, info(d).state]));
  function emitting<T>(f: () => T): T {
    const before = states();
    const out = f();
    states().forEach((state, id) => {
      if (before.get(id) !== state) listeners.forEach((cb) => cb({ id, state }));
    });
    return out;
  }
  const detectOne = (d: Def) => !d.editable && detected.set(d.id, d.installed ? { bin: d.id, path: `/usr/local/bin/${d.id}`, version: d.installed } : { bin: d.id });
  const invalid = (message: string): EngineError => ({ code: "invalidLaunch", message });

  return {
    list: async () => DEFS.map(info),
    detect: async () => emitting(() => (DEFS.forEach(detectOne), DEFS.map(info))),
    async test(id) {
      const d = def(id);
      emitting(() => detectOne(d));
      const [state, message] = health(d);
      return state === "ready" ? { ok: true, message: d.editable ? "Command line confirmed" : `${d.id} ${d.installed} at /usr/local/bin/${d.id}`, latencyMs: 120 } : { ok: false, message: message ?? "", latencyMs: 120 };
    },
    async setEnabled(id, value) {
      const d = def(id);
      return emitting(() => (enabled.set(id, value), info(d)));
    },
    async setAuthMode(id, mode) {
      const d = def(id);
      if (!d.modes.some((m) => m[0] === mode)) throw { code: "invalidAuthMode", message: `${d.name} has no auth mode \`${mode}\`` } satisfies EngineError;
      return emitting(() => (modes.set(id, mode), info(d)));
    },
    async doctor() {
      const findings: DoctorFinding[] = [];
      DEFS.map(info)
        .filter((p) => p.enabled && p.state !== "off")
        .forEach((p) => {
          if (p.state === "probing") findings.push({ provider: p.id, level: "info", code: "notDetected", message: `${p.name} has not been detected yet` });
          else if (p.state === "needsConfirm") findings.push({ provider: p.id, level: "warn", code: "launchUnconfirmed", message: p.message ?? "" });
          else if (p.state === "needsKey") findings.push({ provider: p.id, level: "warn", code: "keyMissing", message: p.message ?? "" });
          else if (p.state === "notInstalled") findings.push({ provider: p.id, level: "error", code: "cliMissing", message: p.message ?? "" });
          else findings.push({ provider: p.id, level: "ok", code: p.cli ? "cliFound" : "keyFound", message: p.cli ? `${p.cli.bin} ${p.cli.version} at ${p.cli.path}` : `${p.name} is configured` });
        });
      return findings;
    },
    enforcement: async () => structuredClone(MOCK_ENFORCEMENT),
    caps: async (id) => ({ caps: structuredClone(capsOfProvider(def(id).id)), source: negotiated.has(id) ? "runtime" : "static" }),
    experimental: async () => experimental,
    setExperimental: async (on) => emitting(() => ((experimental = on), experimental)),
    async confirmLaunch(id, command, args) {
      const d = def(id);
      if (!d.experimental) throw invalid(`${d.name} has no command line to confirm`);
      if (!command.startsWith("/") || /[\n\r]/.test(command)) throw invalid("the program must be an absolute path on one line");
      if (d.editable ? args.some((a) => !a.trim() || /[\n\r]/.test(a)) : args.join("\0") !== d.args.join("\0")) throw invalid(d.editable ? "every argument must be a non-empty single line (at most 64 of them)" : `${d.name} starts with \`${d.args.join(" ")}\`: the arguments are fixed`);
      return emitting(() => (confirmed.set(id, { command, args, at: Date.now() }), info(d)));
    },
    async revokeLaunch(id) {
      const d = def(id);
      return emitting(() => (confirmed.delete(id), info(d)));
    },
    async setWeakWriter(id, allow, typed = "") {
      const d = def(id);
      if (allow && (!d.experimental || typed.trim() !== d.id)) throw { code: "confirmationRequired", message: `type \`${d.id}\` to allow it to change files` } satisfies EngineError;
      if (allow) weakWriter.add(id);
      else weakWriter.delete(id);
      return info(d);
    },
    async testRun(id): Promise<ProbeReport> {
      const d = def(id);
      const p = info(d);
      if (d.experimental && (!experimental || p.state !== "ready")) throw { code: "providerNotEnabled", message: `${d.id} is not available: switch on Experimental providers, enable ${d.id} and confirm its command line in Settings > Providers` } satisfies EngineError;
      negotiated.add(id);
      return { provider: id, ok: true, model: d.id === "claude" ? "claude-haiku-4-5-20251001" : "default", caps: structuredClone(capsOfProvider(id)), negotiated: true, effective: { permission: "readOnly" }, ms: 640 };
    },
    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
