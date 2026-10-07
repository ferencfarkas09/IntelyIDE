import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en/mcp.json";
import hu from "../../i18n/locales/hu/mcp.json";
import type { McpRunServer, McpServerView, McpToolView } from "../../ipc/mcp";
import {
  allowReadOnlyPatch,
  applyPolicyPatch,
  argsFromText,
  argsProblem,
  changedSinceConfirm,
  commandProblem,
  EDITOR_CODES,
  editorErrorKey,
  errorField,
  errorInfo,
  escapeForDisplay,
  EXEC_VAR_TABLE,
  filterTools,
  isExecVar,
  isSecretName,
  loosensBlocked,
  mcpDefaultSelection,
  mcpProviderSupported,
  mcpRunErrorKey,
  mcpStartIds,
  nameProblem,
  orderTools,
  pickerWarnings,
  pruneSelection,
  resetRulesPatch,
  resourcesRule,
  RUN_CODES,
  staleRules,
  stateTone,
  TEST_CODES,
  testErrorKey,
  toolMark,
  urlProblem,
  varNameProblem,
} from "./logic";

const tool = (over: Partial<McpToolView> = {}): McpToolView => ({
  name: "echo", key: "echo", readOnly: false, readOnlyHint: null, destructiveHint: null, policy: null, effectivePolicy: "ask", blockedByDefault: false, seeded: false, ...over,
});

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: "m1", name: "fixture", transport: "stdio", command: "node", args: [], env: [], headers: [], enabled: true, defaultPolicy: "ask", tools: [], toolsTestedAt: 1, toolsStale: false,
  staleToolPolicies: [], serverInfo: null, state: "ready", confirmed: true, imported: false, confirmHash: "h", argsDisplay: [], codeFiles: [], fetchesCode: false, createdAt: 0, updatedAt: 0, ...over,
});

const run = (over: Partial<McpRunServer> = {}): McpRunServer => ({
  id: "m1", name: "fixture", transport: "stdio", defaultOn: true, available: true, toolCount: 3, readOnlyCount: 1, defaultPolicy: "ask", hasDenied: false, hasSecretEnv: false, exposedCount: 0, ...over,
});

describe("names and variables", () => {
  it("accepts the slug of spec 2.3 and refuses what the CLI or the broker would split wrongly", () => {
    for (const ok of ["github", "a", "my-server-2", "a".repeat(32)]) expect(nameProblem(ok), ok).toBeNull();
    for (const bad of ["", "GitHub", "1abc", "my_server", "a".repeat(33), "-x", "claude-code", "intely-x", "mcp", "agent", "task"]) expect(nameProblem(bad), bad).toBe("mcpBadName");
    expect(nameProblem("github", ["Github"])).toBe("mcpNameTaken");
    expect(nameProblem("github", ["docs"])).toBeNull();
  });

  it("flags names that look like secrets with the same words as Rust", () => {
    for (const secret of ["GITHUB_TOKEN", "api_key", "Authorization", "X-Api-Key", "DB_PASSWORD", "client_secret", "passwd", "OAUTH_X"]) expect(isSecretName(secret), secret).toBe(true);
    for (const plain of ["LOG_LEVEL", "NODE_ENV", "X-Team", "API_HOST", "REGION"]) expect(isSecretName(plain), plain).toBe(false);
  });

  it("refuses exactly the exec-affecting names of spec 2.4 (the table is the shared fixture)", () => {
    const spec = ["PATH", "HOME", "SHELL", "TMPDIR", "IFS", "ENV", "BASH_ENV", "BASHOPTS", "SHELLOPTS", "PS4", "PROMPT_COMMAND", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONINSPECT", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GOFLAGS", "GOPROXY", "RUSTC_WRAPPER", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
    expect([...EXEC_VAR_TABLE.exact, ...EXEC_VAR_TABLE.anyCase].sort()).toEqual([...spec].sort());
    expect(EXEC_VAR_TABLE.prefixAnyCase).toEqual(["npm_config_"]);
    for (const name of spec) expect(varNameProblem("env", name), name).toBe("mcpExecVar");
    // proxy names in any case, and the npm_config_ family in three spellings
    for (const name of ["http_proxy", "Https_Proxy", "no_proxy", "npm_config_registry", "NPM_CONFIG_REGISTRY", "Npm_Config_Script_Shell"]) expect(isExecVar(name), name).toBe(true);
    for (const benign of ["LOG_LEVEL", "API_HOST", "NODE_ENV", "TZ", "path"]) expect(isExecVar(benign), benign).toBe(false);
  });

  it("applies the name shape, the refused prefixes and the headers the client owns", () => {
    expect(varNameProblem("env", "LOG_LEVEL")).toBeNull();
    for (const bad of ["1X", "A-B", "A".repeat(65), "INTELY_TOKEN", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "GIT_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]) expect(varNameProblem("env", bad), bad).toBe("mcpBadVar");
    expect(varNameProblem("env", "")).toBeNull();
    expect(varNameProblem("header", "X-Team")).toBeNull();
    expect(varNameProblem("header", "Authorization")).toBeNull();
    for (const bad of ["Host", "content-length", "Content-Type", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Transfer-Encoding", "Connection", "-X", "X_Y"]) expect(varNameProblem("header", bad), bad).toBe("mcpBadVar");
    // the exec list is for the environment only: PATH is a harmless header name
    expect(varNameProblem("header", "Path")).toBeNull();
  });
});

describe("command, arguments and address", () => {
  it("accepts a full path or a bare program name and refuses a relative one", () => {
    for (const ok of ["npx", "/usr/local/bin/node", "uvx"]) expect(commandProblem(ok), ok).toBeNull();
    for (const bad of ["./x", "../x", "bin/x", "~/x", "~"]) expect(commandProblem(bad), bad).toBe("mcpRelativePath");
    expect(commandProblem("")).toBe("mcpBadCommand");
    expect(commandProblem("   ")).toBe("mcpBadCommand");
    expect(commandProblem("a".repeat(1025))).toBe("mcpBadCommand");
    expect(commandProblem("node\n--eval")).toBe("mcpBadChars");
  });

  it("refuses relative arguments, control and direction characters, and too many", () => {
    expect(argsProblem(["-y", "@modelcontextprotocol/server-github", "/Users/me/projects", "--port=3000"])).toBeNull();
    expect(argsProblem(["a".repeat(4096)])).toBeNull();
    for (const bad of ["./server.js", "../x", "~/x"]) expect(argsProblem([bad]), bad).toBe("mcpRelativePath");
    for (const bad of ["a‮b", "a​b", "a\nb", "a\u001bb", "a\u0000b", "a".repeat(4097)]) expect(argsProblem([bad]), JSON.stringify(bad)).toBe("mcpBadChars");
    expect(argsProblem(Array.from({ length: 65 }, () => "x"))).toBe("mcpTooMany");
  });

  it("takes https, or http to this Mac only, ASCII, no userinfo, no fragment", () => {
    for (const ok of ["https://docs.example.com/mcp", "http://localhost:3000/mcp", "http://127.0.0.1/mcp", "http://[::1]:8080/x", "https://xn--hrnlmo-kva.example/mcp"]) expect(urlProblem(ok), ok).toBeNull();
    for (const bad of ["", "http://example.com/mcp", "ftp://x", "https://user:pw@host/x", "https://host/x#frag", "https://hörnlein.example/mcp", "https://host/a b", "https://", "localhost:3000"]) expect(urlProblem(bad), bad).toBe("mcpBadUrl");
    expect(urlProblem("https://host/x‮")).toBe("mcpBadChars");
  });

  it("splits arguments one per line and drops blank lines and carriage returns", () => {
    expect(argsFromText("-y\r\n@scope/pkg\n\n  spaced  \n")).toEqual(["-y", "@scope/pkg", "  spaced  "]);
    expect(argsFromText("")).toEqual([]);
  });

  it("escapes what the confirm dialog must not trust: non-printable, non-ASCII, padding and doubled spaces", () => {
    expect(escapeForDisplay("plain-arg")).toBe("plain-arg");
    expect(escapeForDisplay("a‮b")).toBe("a\\u{202e}b");
    expect(escapeForDisplay("héllo")).toBe("h\\u{e9}llo");
    expect(escapeForDisplay(" lead")).toBe("␣lead");
    expect(escapeForDisplay("trail  ")).toBe("trail␣␣");
    expect(escapeForDisplay("a  b")).toBe("a␣␣b");
    expect(escapeForDisplay("a b")).toBe("a b");
    expect(escapeForDisplay("😀")).toBe("\\u{1f600}");
  });
});

describe("tools and rules", () => {
  const tools = [
    tool({ name: "z_read", key: "z_read", readOnlyHint: true, readOnly: true }),
    tool({ name: "mystery", key: "mystery", readOnlyHint: null }),
    tool({ name: "write_note", key: "write_note", readOnlyHint: false }),
    tool({ name: "a_read", key: "a_read", readOnlyHint: true, readOnly: true }),
    tool({ name: "delete_it", key: "delete_it", readOnlyHint: false }),
  ];

  it("words what the server says, and orders changing tools first, then not stated, then read-only, by name inside a group", () => {
    expect([toolMark(tools[0]), toolMark(tools[1]), toolMark(tools[2])]).toEqual(["reads", "unknown", "writes"]);
    expect(orderTools(tools).map((x) => x.name)).toEqual(["delete_it", "write_note", "mystery", "a_read", "z_read"]);
    expect(tools.map((x) => x.name)).toEqual(["z_read", "mystery", "write_note", "a_read", "delete_it"]);
  });

  it("filters by name or description", () => {
    const list = [tool({ name: "get_issue", key: "get_issue", description: "Reads one issue" }), tool({ name: "write_note", key: "write_note" })];
    expect(filterTools(list, "issue").map((x) => x.name)).toEqual(["get_issue"]);
    expect(filterTools(list, "  NOTE ").map((x) => x.name)).toEqual(["write_note"]);
    expect(filterTools(list, "")).toHaveLength(2);
  });

  it("'Allow all read-only tools' skips blocked-by-default tools, tools already allowed, and everything while the marks are stale", () => {
    const s = server({ tools: [tool({ key: "a", name: "a", readOnly: true }), tool({ key: "b", name: "b", readOnly: true, policy: "allow" }), tool({ key: "git_log", name: "git_log", readOnly: true, blockedByDefault: true }), tool({ key: "w", name: "w" })] });
    expect(allowReadOnlyPatch(s)).toEqual({ tools: [{ tool: "a", policy: "allow" }] });
    expect(allowReadOnlyPatch({ ...s, toolsStale: true })).toBeNull();
    expect(allowReadOnlyPatch(server({ tools: [tool({ readOnly: false })] }))).toBeNull();
  });

  it("'Reset rules' removes the user's own overrides only and keeps the seeded ones", () => {
    const s = server({
      tools: [tool({ key: "a", name: "a", policy: "allow" }), tool({ key: "git_commit", name: "git_commit", policy: "deny", seeded: true, blockedByDefault: true }), tool({ key: "c", name: "c" })],
      staleToolPolicies: [{ tool: "resources", policy: "deny" }, { tool: "gone", policy: "allow" }],
    });
    expect(resetRulesPatch(s)).toEqual({ tools: [{ tool: "a", policy: null }, { tool: "resources", policy: null }] });
    expect(resetRulesPatch(server({ tools: [tool({ key: "git_commit", policy: "deny", seeded: true })] }))).toBeNull();
  });

  it("reads the rule of the pseudo-tool `resources` from a tool entry or from the rules of unlisted tools, and keeps it out of the stale list", () => {
    expect(resourcesRule(server())).toBeNull();
    expect(resourcesRule(server({ staleToolPolicies: [{ tool: "resources", policy: "deny" }] }))).toBe("deny");
    expect(resourcesRule(server({ tools: [tool({ key: "resources", policy: "allow" })] }))).toBe("allow");
    expect(staleRules({ staleToolPolicies: [{ tool: "resources", policy: "deny" }, { tool: "gone", policy: "allow" }] })).toEqual([{ tool: "gone", policy: "allow" }]);
  });

  it("asks before loosening a tool that is denied because it looks like a commit, push or deploy", () => {
    const blocked = tool({ blockedByDefault: true, effectivePolicy: "deny", policy: "deny", seeded: true });
    expect(loosensBlocked(blocked, "allow", "ask")).toBe(true);
    expect(loosensBlocked(blocked, "ask", "ask")).toBe(true);
    expect(loosensBlocked(blocked, "inherit", "ask")).toBe(true);
    expect(loosensBlocked(blocked, "inherit", "deny")).toBe(false);
    expect(loosensBlocked(blocked, "deny", "ask")).toBe(false);
    expect(loosensBlocked(tool({ effectivePolicy: "deny", policy: "deny" }), "allow", "ask")).toBe(false);
    expect(loosensBlocked(tool({ blockedByDefault: true, effectivePolicy: "ask" }), "allow", "ask")).toBe(false);
  });

  it("applies a policy patch to a draft the way the backend will answer it", () => {
    const s = server({ tools: [tool({ key: "a", name: "a" }), tool({ key: "git", name: "git", policy: "deny", effectivePolicy: "deny", seeded: true })], staleToolPolicies: [{ tool: "gone", policy: "allow" }] });
    applyPolicyPatch(s, { defaultPolicy: "allow", tools: [{ tool: "git", policy: "allow", acknowledgeBlocked: true }, { tool: "gone", policy: null }, { tool: "resources", policy: "deny" }] });
    expect(s.defaultPolicy).toBe("allow");
    expect(s.tools[0]).toMatchObject({ policy: null, effectivePolicy: "allow" });
    expect(s.tools[1]).toMatchObject({ policy: "allow", effectivePolicy: "allow", seeded: false });
    expect(s.staleToolPolicies).toEqual([{ tool: "resources", policy: "deny" }]);
  });
});

describe("rows and states", () => {
  it("colours a state by what it needs, and never paints a server that was never tested green", () => {
    expect(stateTone({ state: "ready", toolsTestedAt: 5 })).toBe("ok");
    expect(stateTone({ state: "ready", toolsTestedAt: null })).toBe("neutral");
    expect(stateTone({ state: "needsConfirm", toolsTestedAt: null })).toBe("warn");
    expect(stateTone({ state: "secretMissing", toolsTestedAt: 5 })).toBe("warn");
    expect(stateTone({ state: "invalid", toolsTestedAt: 5 })).toBe("danger");
    expect(stateTone({ state: "unsupported", toolsTestedAt: null })).toBe("danger");
  });

  it("calls a tested server that is unconfirmed now 'changed since you confirmed it'", () => {
    expect(changedSinceConfirm({ confirmed: false, toolsTestedAt: 5 })).toBe(true);
    expect(changedSinceConfirm({ confirmed: false, toolsTestedAt: null })).toBe(false);
    expect(changedSinceConfirm({ confirmed: true, toolsTestedAt: 5 })).toBe(false);
  });
});

describe("error codes", () => {
  const hasKeys = (key: string) => key in en && key in hu;

  it("every code of the editor, of a Test and of a start has an English and a Hungarian text", () => {
    for (const code of EDITOR_CODES) expect(hasKeys(`mcp.err.${code}`), `mcp.err.${code}`).toBe(true);
    for (const code of TEST_CODES) expect(hasKeys(`mcp.test.code.${code}`), `mcp.test.code.${code}`).toBe(true);
    for (const code of RUN_CODES) expect(hasKeys(`mcp.runerr.${code}`), `mcp.runerr.${code}`).toBe(true);
    for (const key of ["mcp.err.generic", "mcp.test.code.generic", "mcp.runerr.generic"]) expect(hasKeys(key), key).toBe(true);
  });

  it("maps a known code to its key and any other code to the generic one", () => {
    expect(editorErrorKey("mcpExecVar")).toBe("mcp.err.mcpExecVar");
    expect(editorErrorKey("somethingNew")).toBe("mcp.err.generic");
    expect(testErrorKey({ code: "mcpTimeout" })).toBe("mcp.test.code.mcpTimeout");
    expect(testErrorKey({ code: "mcpAuth" })).toBe("mcp.test.code.mcpAuth");
    expect(testErrorKey({ code: "mcpAuth", detail: "oauth" })).toBe("mcp.test.code.mcpAuthOauth");
    expect(testErrorKey({ code: "weird" })).toBe("mcp.test.code.generic");
    expect(mcpRunErrorKey("mcpCodeInRunDir")).toBe("mcp.runerr.mcpCodeInRunDir");
    expect(mcpRunErrorKey("noSafetyNet")).toBe("mcp.runerr.generic");
  });

  it("puts each code under the field it is about", () => {
    expect(errorField("mcpBadName")).toBe("name");
    expect(errorField("mcpNameTaken")).toBe("name");
    expect(errorField("mcpRelativePath")).toBe("command");
    expect(errorField("mcpSecretInArgs")).toBe("args");
    expect(errorField("mcpSecretInUrl")).toBe("url");
    expect(errorField("mcpExecVar")).toBe("vars");
    expect(errorField("readOnly")).toBe("form");
  });

  it("reads an EngineError and anything else that can be thrown", () => {
    expect(errorInfo({ code: "mcpBusy", message: "busy", detail: "x" })).toEqual({ code: "mcpBusy", message: "busy", detail: "x" });
    expect(errorInfo(new Error("boom"))).toEqual({ code: "unknown", message: "boom" });
    expect(errorInfo("plain")).toEqual({ code: "unknown", message: "plain" });
  });
});

describe("the run picker rules", () => {
  it("supports MCP for Claude and the mock provider only, and sends no ids for any other", () => {
    expect(mcpProviderSupported("claude")).toBe(true);
    expect(mcpProviderSupported("mock")).toBe(true);
    for (const p of ["codex", "gemini", "copilot", "acp", ""]) expect(mcpProviderSupported(p), p).toBe(false);
    expect(mcpStartIds(["a", "b", "a"], "claude")).toEqual(["a", "b"]);
    expect(mcpStartIds(["a"], "codex")).toEqual([]);
  });

  it("defaults to the servers that are on by default and can start, and prunes the ones that no longer can", () => {
    const list = [run({ id: "a" }), run({ id: "b", defaultOn: false }), run({ id: "c", available: false, unavailable: "needsConfirm" })];
    expect(mcpDefaultSelection(list)).toEqual(["a"]);
    expect(pruneSelection(["a", "b", "c", "gone"], list)).toEqual(["a", "b"]);
  });

  it("warns per mode, only while a server is selected: the mode line, the secret environment, the tools that run unasked", () => {
    const withSecret = run({ id: "a", name: "github", hasSecretEnv: true, exposedCount: 2 });
    const plain = run({ id: "b", name: "docs", exposedCount: 1 });
    expect(pickerWarnings("automatic", [])).toEqual({ mode: null, secretEnv: [], exposure: null });
    expect(pickerWarnings("automatic", [withSecret, plain])).toEqual({ mode: "automatic", secretEnv: ["github"], exposure: { count: 3, names: ["github", "docs"] } });
    expect(pickerWarnings("bypass", [withSecret]).mode).toBe("bypass");
    expect(pickerWarnings("readOnly", [withSecret])).toEqual({ mode: "plan", secretEnv: [], exposure: null });
    expect(pickerWarnings("ask", [withSecret])).toEqual({ mode: null, secretEnv: [], exposure: null });
    expect(pickerWarnings("edit", [withSecret]).secretEnv).toEqual([]);
  });
});
