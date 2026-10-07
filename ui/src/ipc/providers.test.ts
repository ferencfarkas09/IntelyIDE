import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockProviders } from "./mock/providers";
import { createMockSettings } from "./mock/settings";
import { createTauriProviders } from "./providers";
import { createTauriSecrets, createTauriSettings } from "./settings";

const rpc = vi.hoisted(() => ({ call: vi.fn(async () => undefined), subscribe: vi.fn(() => () => {}) }));
vi.mock("./rpc", () => rpc);

describe("providers mock", () => {
  it("claude is on by default, the rest off, and nothing is detected before detect()", async () => {
    const list = await createMockProviders().list();
    expect(list.map((p) => [p.id, p.enabled, p.state])).toEqual([["claude", true, "probing"], ["codex", false, "off"], ["gemini", false, "off"], ["copilot", false, "off"], ["opencode", false, "off"], ["goose", false, "off"], ["qwen", false, "off"], ["acp", false, "off"]]);
    expect(list.every((p) => p.cli === undefined)).toBe(true);
  });

  it("detect finds the installed CLIs; the switch and auth mode drive the state and emit events", async () => {
    const providers = createMockProviders();
    const seen: string[] = [];
    providers.onState((e) => seen.push(`${e.id}:${e.state}`));
    const detected = await providers.detect();
    expect(detected.find((p) => p.id === "claude")).toMatchObject({ state: "ready", cli: { version: "2.1.284" } });
    await providers.setExperimental(true);
    expect((await providers.setEnabled("gemini", true)).state).toBe("notInstalled");
    expect((await providers.setAuthMode("claude", "apiKey")).state).toBe("needsKey");
    expect(seen).toEqual(["claude:ready", "gemini:notInstalled", "claude:needsKey"]);
    await expect(providers.setAuthMode("claude", "magic")).rejects.toMatchObject({ code: "invalidAuthMode" });
    await expect(providers.setEnabled("nope", true)).rejects.toMatchObject({ code: "unknownProvider" });
  });

  it("test reports the CLI, and why a provider is not usable", async () => {
    const providers = createMockProviders();
    expect(await providers.test("claude")).toMatchObject({ ok: true, message: "claude 2.1.284 at /usr/local/bin/claude" });
    expect(await providers.test("gemini")).toMatchObject({ ok: false, message: "gemini was not found on PATH" });
  });

  it("doctor lists the enabled providers", async () => {
    const providers = createMockProviders();
    await providers.detect();
    await providers.setExperimental(true);
    await providers.setEnabled("gemini", true);
    expect((await providers.doctor()).map((f) => [f.provider, f.code])).toEqual([["claude", "cliFound"], ["gemini", "cliMissing"]]);
  });
});

describe("providers mock: experimental switch, confirmed command line, weak writer, test run", () => {
  it("every non-Claude provider needs the global switch: with it off the state is off whatever the provider switch says", async () => {
    const providers = createMockProviders();
    await providers.detect();
    expect(await providers.experimental()).toBe(false);
    const gemini = await providers.setEnabled("gemini", true);
    expect(gemini).toMatchObject({ enabled: true, experimental: true, state: "off" });
    expect((await providers.list()).find((p) => p.id === "claude")).toMatchObject({ experimental: false, state: "ready" });
    expect(await providers.setExperimental(true)).toBe(true);
    expect((await providers.list()).find((p) => p.id === "gemini")?.state).toBe("notInstalled");
  });

  it("a command line is confirmed once with a fingerprint; fixed arguments and relative programs are refused", async () => {
    const providers = createMockProviders();
    await providers.detect();
    await providers.setExperimental(true);
    expect(await providers.setEnabled("codex", true)).toMatchObject({ state: "needsConfirm", launch: { command: "/usr/local/bin/codex", args: ["app-server"], status: "unconfirmed", verified: true } });
    await expect(providers.confirmLaunch("codex", "/usr/local/bin/codex", ["app-server", "--yolo"])).rejects.toMatchObject({ code: "invalidLaunch" });
    await expect(providers.confirmLaunch("codex", "codex", ["app-server"])).rejects.toMatchObject({ code: "invalidLaunch" });
    await expect(providers.confirmLaunch("claude", "/usr/local/bin/claude", [])).rejects.toMatchObject({ code: "invalidLaunch" });
    const ok = await providers.confirmLaunch("codex", "/usr/local/bin/codex", ["app-server"]);
    expect(ok).toMatchObject({ state: "ready", launch: { status: "confirmed" } });
    expect(ok.launch?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await providers.revokeLaunch("codex")).state).toBe("needsConfirm");
  });

  it("allow weak writer needs the provider id typed, is per provider and off by default", async () => {
    const providers = createMockProviders();
    expect((await providers.list()).every((p) => !p.allowWeakWriter)).toBe(true);
    await expect(providers.setWeakWriter("gemini", true, "yes")).rejects.toMatchObject({ code: "confirmationRequired" });
    await expect(providers.setWeakWriter("claude", true, "claude")).rejects.toMatchObject({ code: "confirmationRequired" });
    expect((await providers.setWeakWriter("gemini", true, "gemini")).allowWeakWriter).toBe(true);
    expect((await providers.list()).find((p) => p.id === "codex")?.allowWeakWriter).toBe(false);
    expect((await providers.setWeakWriter("gemini", false)).allowWeakWriter).toBe(false);
  });

  it("a test run needs a running provider, negotiates capabilities and sends no prompt; caps then report the runtime source", async () => {
    const providers = createMockProviders();
    await providers.detect();
    await expect(providers.testRun("codex")).rejects.toMatchObject({ code: "providerNotEnabled" });
    expect((await providers.caps("codex")).source).toBe("static");
    await providers.setExperimental(true);
    await providers.setEnabled("codex", true);
    await providers.confirmLaunch("codex", "/usr/local/bin/codex", ["app-server"]);
    const report = await providers.testRun("codex");
    expect(report).toMatchObject({ ok: true, negotiated: true, effective: { permission: "readOnly" } });
    expect((await providers.caps("codex")).source).toBe("runtime");
  });
});

describe("settings mock", () => {
  it("null removes a key, like the backend", async () => {
    const settings = createMockSettings();
    await settings.set("editor", { a: 1, b: 2 });
    expect(await settings.set("editor", { a: null })).toEqual({ b: 2 });
  });
});

describe("tauri wiring", () => {
  beforeEach(() => rpc.call.mockClear());

  it("maps every method to its command", async () => {
    const providers = createTauriProviders();
    const settings = createTauriSettings();
    const secrets = createTauriSecrets();
    await Promise.all([
      providers.list(), providers.detect(), providers.test("claude"), providers.setEnabled("codex", true), providers.setAuthMode("codex", "apiKey"), providers.doctor(),
      providers.experimental(), providers.setExperimental(true), providers.confirmLaunch("codex", "/usr/local/bin/codex", ["app-server"]), providers.revokeLaunch("codex"),
      providers.setWeakWriter("gemini", true, "gemini"), providers.testRun("codex", "m"),
      settings.get("editor"), settings.set("editor", { a: 1 }),
      secrets.has("k"), secrets.set("k", "v"), secrets.remove("k"),
    ]);
    expect((rpc.call.mock.calls as unknown[][]).map((c) => [c[0], c[1]])).toEqual([
      ["providers_list", undefined], ["providers_detect", undefined], ["providers_test", { id: "claude" }], ["providers_set_enabled", { id: "codex", enabled: true }],
      ["providers_set_auth_mode", { id: "codex", mode: "apiKey" }], ["providers_doctor", undefined],
      ["providers_experimental_get", undefined], ["providers_experimental_set", { on: true }], ["providers_confirm_launch", { id: "codex", command: "/usr/local/bin/codex", args: ["app-server"] }],
      ["providers_revoke_launch", { id: "codex" }], ["providers_set_weak_writer", { id: "gemini", allow: true, typed: "gemini" }], ["providers_test_run", { id: "codex", model: "m" }],
      ["settings_get", { ns: "editor" }], ["settings_set", { ns: "editor", patch: { a: 1 } }],
      ["secrets_has", { key: "k" }], ["secrets_set", { key: "k", value: "v" }], ["secrets_remove", { key: "k" }],
    ]);
  });

  it("subscribes to the backend events", () => {
    createTauriSettings().onChange(() => {});
    createTauriProviders().onState(() => {});
    expect((rpc.subscribe.mock.calls as unknown[][]).map((c) => c[0])).toEqual(["settings:changed", "providers:state"]);
  });
});
