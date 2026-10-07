import type { EngineError } from "../../bindings";
import type {
  McpImportEntry,
  McpImportPick,
  McpImportPreview,
  McpImportResult,
  McpIpc,
  McpList,
  McpRunServer,
  McpSaveInput,
  McpSecretPresence,
  McpTestReport,
  McpVarInput,
  McpWorkspaceState,
} from "../mcp";
import type { SettingsIpc } from "../settings";
import {
  blockedByDefault,
  confirmHash,
  EXEC_VAR,
  FIXTURE_TOOLS,
  fetchesCode,
  fingerprint,
  SECRET_NAME,
  serverView,
  stateOf,
  type McpVarRec,
  type ServerRec,
} from "./mcpModel";

/*
 * The browser and test double of the `mcp_*` commands ((design notes: mcp-management-spec) 7.10). Deterministic, in memory, no network and no
 * process: a Test answers from the command or address of the record (`fail` in the command: the program exits, `slow`: it needs 30 s,
 * `oauth` in the address: the OAuth sentence), and the tools it "learns" are the fixture tools of the spec (9.1). Like the real thing, a
 * secret value is never stored: only whether a slot has one. Every mutation fires `settings:changed` for the namespace `mcp` through the
 * settings mock, which is how the real section learns about changes made elsewhere. `?mcp=empty` starts without servers, `?jail=readOnly`
 * and `?secrets=degraded` show the two banners.
 */

export interface MockMcpOptions {
  /** Start without servers (the empty state). */
  empty?: boolean;
  /** Milliseconds a Test takes: 0 in unit tests, a short pause in the browser so the running state can be seen. */
  delayMs?: number;
  jail?: McpList["jail"];
  now?: () => number;
}

const err = (code: string, message: string, detail?: string): EngineError => ({ code, message, ...(detail ? { detail } : {}) });
const sleep = (ms: number) => new Promise<void>((r) => (ms > 0 ? setTimeout(r, ms) : r()));

export function createMockMcp(settings?: SettingsIpc, opts: MockMcpOptions = {}): McpIpc {
  const search = new URLSearchParams(globalThis.location?.search ?? "");
  const delayMs = opts.delayMs ?? (import.meta.env?.MODE === "test" ? 0 : 450);
  const now = opts.now ?? Date.now;
  const jail = opts.jail ?? (search.get("jail") === "readOnly" ? "readOnly" : "off");
  const degraded = search.get("secrets") === "degraded";
  const servers: ServerRec[] = [];
  const overrides = new Map<string, Map<string, "on" | "off">>();
  let staged: { preview: McpImportPreview; used: boolean } | null = null;
  let nextId = 1;
  let rev = 0;

  const newId = () => `m${(nextId++).toString(16).padStart(12, "0")}`;
  const notify = () => void settings?.set("mcp", { rev: ++rev });
  const find = (id: string) => {
    const s = servers.find((x) => x.id === id);
    if (!s) throw err("mcpUnknownServer", "There is no such MCP server.");
    return s;
  };

  const list = (workspaceId?: string | null): McpList => ({
    schema: 1,
    servers: servers.map(serverView),
    workspace: {
      id: workspaceId ?? null,
      overrides: [...(overrides.get(workspaceId ?? "")?.entries() ?? [])].map(([serverId, state]) => ({ serverId, state })),
    },
    secrets: degraded
      ? { backend: "memory", degraded: true, message: "The Keychain was denied: this build is not signed. Secrets stay in memory until you restart." }
      : { backend: "memory", degraded: false, message: null },
    jail,
    problems: [],
  });

  const varsOf = (inputs: McpVarInput[] | undefined, before: McpVarRec[]): McpVarRec[] =>
    (inputs ?? []).map((v) => {
      const old = before.find((b) => b.name === v.name);
      if (!v.secret) return { name: v.name, secret: false, value: v.value ?? "", present: true };
      // a secret keeps its slot unless a new value arrives; the value itself is dropped here, like the Keychain write that follows it
      return { name: v.name, secret: true, present: v.secretValue !== undefined ? v.secretValue.length > 0 : !!old?.secret && old.present };
    });

  function validate(input: McpSaveInput) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.name) || /^(claude|intely)/.test(input.name) || ["mcp", "agent", "task"].includes(input.name)) throw err("mcpBadName", "Invalid name.");
    if (servers.some((s) => s.name === input.name && s.id !== input.id)) throw err("mcpNameTaken", "Another server already has this name.");
    if (input.transport === "stdio") {
      const command = input.command?.trim() ?? "";
      if (!command) throw err("mcpBadCommand", "Enter the program to run.");
      if (command.startsWith("~") || (command.includes("/") && !command.startsWith("/"))) throw err("mcpRelativePath", "Use a full path.");
      if ((input.args ?? []).some((a) => /^(sk-|ghp_|github_pat_|xox[bp]-)/.test(a))) throw err("mcpSecretInArgs", "An argument looks like a key.");
      if ((input.args ?? []).some((a) => /^(\.\.?\/|~)/.test(a))) throw err("mcpRelativePath", "Use a full path.");
    } else if (!/^https:\/\/[^\s/?#]+|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(input.url ?? "")) {
      throw err("mcpBadUrl", "Use an https address.");
    }
    for (const v of [...(input.env ?? []), ...(input.headers ?? [])]) {
      if (EXEC_VAR.test(v.name) && input.transport === "stdio") throw err("mcpExecVar", "This variable cannot be set here.");
      if (!v.secret && SECRET_NAME.test(v.name)) throw err("mcpPlainSecretName", "This name looks like a secret.");
    }
  }

  function seed() {
    const base = (partial: Partial<ServerRec> & Pick<ServerRec, "name" | "transport">): ServerRec => {
      const t = now() - 86_400_000;
      return { id: newId(), args: [], env: [], headers: [], enabled: false, defaultPolicy: "ask", toolPolicies: [], tools: [], toolsTestedAt: null, toolsFingerprint: null, serverInfo: null, imported: false, confirmedHash: null, createdAt: t, updatedAt: t, ...partial };
    };
    const fixture = base({ name: "fixture", transport: "stdio", command: "node", args: ["/Users/example/tools/mcp-fixture/server.mjs"], enabled: true, env: [{ name: "LOG_LEVEL", secret: false, value: "info", present: true }] });
    fixture.confirmedHash = confirmHash(fixture);
    fixture.tools = FIXTURE_TOOLS.map((t) => ({ ...t }));
    fixture.toolsTestedAt = now() - 120_000;
    fixture.toolsFingerprint = fingerprint(fixture);
    fixture.serverInfo = { name: "mcp-fixture-server", version: "0.1.0", protocolVersion: "2025-06-18" };
    fixture.toolPolicies = [{ tool: "git_commit", policy: "deny", seeded: true }, { tool: "echo", policy: "allow" }];
    const docs = base({ name: "docs", transport: "http", url: "https://docs.example.com/mcp", headers: [{ name: "Authorization", secret: true, present: true }] });
    const github = base({ name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: [{ name: "GITHUB_TOKEN", secret: true, present: false }] });
    github.confirmedHash = confirmHash(github);
    servers.push(fixture, docs, github);
  }
  if (!opts.empty && search.get("mcp") !== "empty") seed();

  function runServer(s: ServerRec, provider: string, workspaceId: string | null | undefined): McpRunServer {
    const v = serverView(s);
    const ws = overrides.get(workspaceId ?? "")?.get(s.id);
    const unavailable: McpRunServer["unavailable"] | undefined =
      provider !== "claude" && provider !== "mock" ? "unsupportedProvider" : jail === "readOnly" ? "readOnlyJail" : v.state === "ready" ? undefined : v.state;
    return {
      id: s.id,
      name: s.name,
      transport: s.transport,
      defaultOn: ws ? ws === "on" : s.enabled,
      available: !unavailable,
      ...(unavailable ? { unavailable } : {}),
      toolCount: v.tools.length,
      readOnlyCount: v.tools.filter((t) => t.readOnly).length,
      defaultPolicy: s.defaultPolicy,
      hasDenied: s.defaultPolicy === "deny" || s.toolPolicies.some((p) => p.policy === "deny"),
      hasSecretEnv: s.transport === "stdio" && s.env.some((e) => e.secret),
      exposedCount: v.toolsStale ? 0 : v.tools.filter((t) => !t.readOnly && t.effectivePolicy !== "deny").length,
    };
  }

  /** What the preview of a Claude Code file shows: names only, one entry per way an entry can go. */
  function importEntries(): McpImportEntry[] {
    const taken = (name: string) => servers.some((s) => s.name === name);
    const entry = (e: Omit<McpImportEntry, "conflict" | "suggestedName"> & { suggestedName?: string }): McpImportEntry => {
      const suggestedName = e.suggestedName ?? e.key;
      return { ...e, suggestedName, conflict: taken(suggestedName), issues: taken(suggestedName) ? [...e.issues, "nameTaken"] : e.issues };
    };
    return [
      entry({ key: "github", transport: "stdio", commandLine: "npx -y @modelcontextprotocol/server-github", env: [{ name: "GITHUB_TOKEN", secret: true }, { name: "LOG_LEVEL", secret: false }], headers: [], issues: [], importable: true }),
      entry({ key: "filesystem", transport: "stdio", commandLine: "npx -y @modelcontextprotocol/server-filesystem /Users/example/projects", env: [], headers: [], issues: [], importable: true }),
      entry({ key: "Sentry Prod", suggestedName: "sentry-prod", transport: "http", urlHost: "mcp.sentry.dev", env: [], headers: [{ name: "Authorization", secret: true }], issues: ["badName"], importable: true }),
      entry({ key: "legacy-sse", transport: "unknown", env: [], headers: [], issues: ["unsupportedTransport"], importable: false }),
      entry({ key: "local-script", transport: "stdio", commandLine: "node ./server.js", env: [], headers: [], issues: ["relativePath"], importable: false }),
      entry({ key: "analytics", transport: "stdio", commandLine: "uvx analytics-mcp", env: [{ name: "UV_INDEX_URL", secret: false }], headers: [], issues: ["badVar"], importable: false }),
    ];
  }

  async function runTest(id: string, timeoutMs?: number): Promise<McpTestReport> {
    if (jail === "readOnly") throw err("readOnly", "Read-only mode does not start MCP servers.");
    const s = find(id);
    if (stateOf(s) === "needsConfirm") throw err("confirmationRequired", "Confirm this server first.", confirmHash(s));
    await sleep(delayMs);
    const target = `${s.command ?? ""} ${s.url ?? ""}`;
    const fail = (error: NonNullable<McpTestReport["error"]>, extra: Partial<McpTestReport> = {}): McpTestReport => ({
      ok: false, ms: 10_000, tools: [], toolCount: 0, truncated: false, newTools: [], removedTools: [], blockedByDefault: [], fetchesCode: fetchesCode(s), error, ...extra,
    });
    if (/fail/.test(target)) {
      return fail({ code: "mcpExited", message: "The program stopped right away.", detail: "3" }, { ms: 180, stderrTail: "Error: Cannot find module '/Users/example/tools/mcp-fixture/server.mjs'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\nexit 3\n" });
    }
    if (/slow/.test(target) && (timeoutMs ?? 10_000) < 30_000) return fail({ code: "mcpTimeout", message: "No answer in time." });
    if (/oauth/.test(target)) return fail({ code: "mcpAuth", message: "The server wants credentials.", detail: "oauth" }, { ms: 220 });
    if ([...s.env, ...s.headers].some((v) => v.secret && !v.present)) return fail({ code: "mcpSecretMissing", message: "A secret has no value yet." }, { ms: 1 });
    const previous = new Set(s.tools.map((t) => t.key));
    const learned = FIXTURE_TOOLS.map((t) => ({ ...t }));
    const fresh = learned.filter((t) => !previous.has(t.key));
    const seeds = fresh.filter((t) => blockedByDefault(t.key, t.destructiveHint) && !s.toolPolicies.some((p) => p.tool === t.key));
    s.toolPolicies = [...s.toolPolicies, ...seeds.map((t) => ({ tool: t.key, policy: "deny" as const, seeded: true }))];
    const removed = [...previous].filter((k) => !learned.some((t) => t.key === k));
    s.tools = learned;
    s.toolsTestedAt = now();
    s.toolsFingerprint = fingerprint(s);
    s.serverInfo = { name: s.name === "fixture" ? "mcp-fixture-server" : `${s.name}-server`, version: "0.1.0", protocolVersion: "2025-06-18" };
    s.updatedAt = now();
    notify();
    const v = serverView(s);
    return {
      ok: true,
      ms: 412,
      protocolVersion: "2025-06-18",
      serverInfo: { name: s.serverInfo.name, version: s.serverInfo.version },
      capabilities: { tools: true, resources: true, prompts: false },
      tools: v.tools,
      toolCount: v.tools.length,
      truncated: false,
      newTools: previous.size ? fresh.map((t) => t.key) : [],
      removedTools: removed,
      blockedByDefault: seeds.map((t) => t.key),
      fetchesCode: fetchesCode(s),
      ...(s.name === "fixture" ? { instructions: "Use echo to check the connection. write_note stores a note in the server's own notebook." } : {}),
    };
  }

  return {
    async list(workspaceId) {
      return list(workspaceId);
    },
    async save(input) {
      validate(input);
      const before = input.id ? find(input.id) : undefined;
      const stdio = input.transport === "stdio";
      const rec: ServerRec = {
        id: before?.id ?? newId(),
        name: input.name,
        transport: input.transport,
        command: stdio ? input.command?.trim() : undefined,
        args: stdio ? [...(input.args ?? [])] : [],
        url: stdio ? undefined : input.url?.trim(),
        env: stdio ? varsOf(input.env, before?.env ?? []) : [],
        headers: stdio ? [] : varsOf(input.headers, before?.headers ?? []),
        enabled: input.enabled,
        defaultPolicy: before?.defaultPolicy ?? "ask",
        toolPolicies: before?.toolPolicies ?? [],
        tools: before?.tools ?? [],
        toolsTestedAt: before?.toolsTestedAt ?? null,
        toolsFingerprint: before?.toolsFingerprint ?? null,
        serverInfo: before?.serverInfo ?? null,
        imported: before?.imported ?? false,
        confirmedHash: before?.confirmedHash ?? null,
        createdAt: before?.createdAt ?? now(),
        updatedAt: now(),
      };
      if (before) servers[servers.indexOf(before)] = rec;
      else servers.push(rec);
      notify();
      return serverView(rec);
    },
    async remove(id) {
      if (!id.startsWith("index:")) servers.splice(servers.indexOf(find(id)), 1);
      for (const map of overrides.values()) map.delete(id);
      notify();
    },
    async setEnabled(id, enabled) {
      const s = find(id);
      if (enabled && stateOf(s) === "needsConfirm") throw err("confirmationRequired", "Confirm this server first.", confirmHash(s));
      s.enabled = enabled;
      s.updatedAt = now();
      notify();
      return serverView(s);
    },
    async confirm(id, hash) {
      const s = find(id);
      if (hash !== confirmHash(s)) throw err("confirmationRequired", "The server changed since the dialog was opened.", confirmHash(s));
      s.confirmedHash = hash;
      notify();
      return serverView(s);
    },
    async workspaceSet(workspaceId, serverId, state: McpWorkspaceState) {
      find(serverId);
      const map = overrides.get(workspaceId) ?? new Map<string, "on" | "off">();
      if (state === "inherit") map.delete(serverId);
      else map.set(serverId, state);
      overrides.set(workspaceId, map);
      notify();
      return list(workspaceId);
    },
    async setPolicy(id, patch) {
      const s = find(id);
      for (const change of patch.tools ?? []) {
        const own = s.toolPolicies.find((p) => p.tool === change.tool);
        if (own?.seeded && !change.acknowledgeBlocked && change.policy !== "deny") throw err("mcpBlockedByDefault", "This tool is blocked by default.");
        s.toolPolicies = s.toolPolicies.filter((p) => p.tool !== change.tool);
        if (change.policy !== null) s.toolPolicies.push({ tool: change.tool, policy: change.policy });
      }
      if (patch.defaultPolicy) s.defaultPolicy = patch.defaultPolicy;
      s.updatedAt = now();
      notify();
      return serverView(s);
    },
    test: runTest,
    async importPreview(token) {
      if (jail === "readOnly") throw err("readOnly", "Read-only mode does not read files for import.");
      if (!token) throw err("tokenExpired", "The file choice expired.");
      await sleep(delayMs);
      const preview: McpImportPreview = { importId: `imp-${rev}-${now()}`, fileName: ".claude.json", entries: importEntries(), skippedKeys: 1, expiresAt: now() + 5 * 60_000 };
      staged = { preview, used: false };
      return structuredClone(preview);
    },
    async importApply(importId, picks: McpImportPick[]) {
      if (!staged || staged.used || staged.preview.importId !== importId || now() > staged.preview.expiresAt) throw err("mcpImportExpired", "The preview expired.");
      const result: McpImportResult = { imported: [], skipped: [] };
      for (const pick of picks) {
        const entry = staged.preview.entries.find((e) => e.key === pick.key);
        if (!entry || !entry.importable) {
          result.skipped.push({ key: pick.key, reason: "notImportable" });
          continue;
        }
        const taken = servers.find((s) => s.name === pick.name);
        if (taken && !pick.replace) {
          result.skipped.push({ key: pick.key, reason: "nameTaken" });
          continue;
        }
        const t = now();
        const http = entry.transport === "http";
        const [command, ...args] = (entry.commandLine ?? "").split(" ");
        const rec: ServerRec = {
          id: taken?.id ?? newId(),
          name: pick.name,
          transport: http ? "http" : "stdio",
          command: http ? undefined : command,
          args: http ? [] : args,
          url: http ? `https://${entry.urlHost}/mcp` : undefined,
          env: entry.env.map((v) => (v.secret ? { name: v.name, secret: true, present: true } : { name: v.name, secret: false, value: "info", present: true })),
          headers: entry.headers.map((v) => ({ name: v.name, secret: true, present: true })),
          enabled: false,
          defaultPolicy: taken?.defaultPolicy ?? "ask",
          toolPolicies: taken?.toolPolicies ?? [],
          tools: taken?.tools ?? [],
          toolsTestedAt: taken?.toolsTestedAt ?? null,
          toolsFingerprint: taken?.toolsFingerprint ?? null,
          serverInfo: taken?.serverInfo ?? null,
          imported: true,
          confirmedHash: null,
          createdAt: taken?.createdAt ?? t,
          updatedAt: t,
        };
        if (taken) servers[servers.indexOf(taken)] = rec;
        else servers.push(rec);
        result.imported.push({ key: pick.key, id: rec.id });
      }
      staged.used = true;
      notify();
      return result;
    },
    async secretsPresent(ids): Promise<McpSecretPresence[]> {
      return servers
        .filter((s) => !ids || ids.includes(s.id))
        .flatMap((s) => [
          ...s.env.filter((v) => v.secret).map((v) => ({ serverId: s.id, slot: `env:${v.name}`, present: v.present })),
          ...s.headers.filter((v) => v.secret).map((v) => ({ serverId: s.id, slot: `hdr:${v.name}`, present: v.present })),
        ]);
    },
    async runServers(workspaceId, provider) {
      return servers.map((s) => runServer(s, provider, workspaceId));
    },
  };
}
