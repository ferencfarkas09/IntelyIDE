import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/workspace", () => {
  const repos = [{ id: "app", name: "app", color: "#8b6cf0", badge: "AP", path: "/r/app", order: 0, pushTargets: {} }];
  return { repos: () => repos, repoConfig: (id: string) => repos.find((r) => r.id === id), workspace: () => undefined };
});

import { execute, getCommand, registerCommand, resetCommands } from "../../platform/commands";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { resetSettings } from "../../platform/settings";
import { getTabType } from "../../platform/tabs";
import { installDomStubs } from "../../store/testing-u2";
import { createMockWebtools, setWebtoolsApi, type WebtoolsApi } from "./api";
import { register } from "./index";
import { setWebtoolsEnabled } from "./toggle";
import type { Detect, TryRequest } from "./types";
import WebtoolsTab from "./WebtoolsTab";

installDomStubs();

const tab = (section: string | null = null) => ({ id: "webtools", type: "webtools", title: "Web", params: { section } });
let api: WebtoolsApi;
let calls: { tryIt: TryRequest[]; deps: boolean[]; asked: string[] };
const detect = (over: Partial<Detect> = {}): Detect => ({ css: false, scss: false, react: false, reactNative: false, backends: [], env: false, bundle: false, packages: [], ...over });

beforeEach(() => {
  calls = { tryIt: [], deps: [], asked: [] };
  const base = createMockWebtools();
  api = {
    ...base,
    tryIt: async (id, r) => (calls.tryIt.push(r), base.tryIt(id, r)),
    depsCheck: async (repo, dir, confirmed) => (calls.deps.push(confirmed), base.depsCheck(repo, dir, confirmed)),
  };
  setWebtoolsApi(api);
  // "Ask agent" opens the New run dialog through this command
  registerCommand({ id: "runs.new", title: "New run", group: "Runs", run: () => void calls.asked.push(newRunPrefill()?.prompt ?? "") });
  registerCommand({ id: "editor.openFile", title: "Open file", group: "File", run: () => {} });
});

afterEach(() => {
  cleanup();
  setWebtoolsApi(undefined);
  takeNewRunPrefill();
  resetCommands();
});

describe("which tools appear", () => {
  it("shows a tool only when the repository has the files it works on", async () => {
    setWebtoolsApi({ ...api, detect: async () => detect({ css: true, scss: true }) });
    render(() => <WebtoolsTab tab={tab()} />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Tokens/ })).toBeTruthy());
    expect(screen.getByRole("radio", { name: /Unused CSS/ })).toBeTruthy();
    for (const absent of [/React/, /Bundle/, /Routes/, /\.env/, /Dependencies/]) expect(screen.queryByRole("radio", { name: absent })).toBeNull();
  });

  it("says so when the repository has nothing any tool works on", async () => {
    setWebtoolsApi({ ...api, detect: async () => detect() });
    render(() => <WebtoolsTab tab={tab()} />);
    await waitFor(() => expect(screen.getByText("Nothing to show here")).toBeTruthy());
  });

  it("a command that names a section opens that one", async () => {
    render(() => <WebtoolsTab tab={tab("routes")} />);
    await waitFor(() => expect(screen.getByTestId("wt-routes")).toBeTruthy());
  });

  it("shows a failed read as text, not as an empty tab", async () => {
    setWebtoolsApi({ ...api, detect: async () => Promise.reject({ code: "io", message: "disk gone" }) });
    render(() => <WebtoolsTab tab={tab()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("disk gone"));
  });
});

describe("tokens and styles", () => {
  it("lists tokens with their usage, unused ones with a confidence, and swatches", async () => {
    render(() => <WebtoolsTab tab={tab("tokens")} />);
    await waitFor(() => expect(screen.getByTestId("wt-tokens")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText("--brand-old").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("img", { name: "--brand #5b8def" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("unused").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sure").length).toBeGreaterThan(0);
    expect(screen.getByText(/could use var\(--brand\)/)).toBeTruthy();
  });

  it("a swatch value that is not a plain colour is never painted", async () => {
    setWebtoolsApi({
      ...api,
      tokens: async () => ({ ...(await api.tokens("app")), tokens: [], swatches: [{ name: "--evil", value: "red; background: url(//x)" }], hardcoded: [], duplicates: [], skipped: [] }),
    });
    render(() => <WebtoolsTab tab={tab("tokens")} />);
    await waitFor(() => expect(screen.getByText("--evil")).toBeTruthy());
    expect(screen.queryByRole("img", { name: /--evil/ })).toBeNull();
  });

  it("Ask agent opens the New run dialog with a precise prompt and starts nothing", async () => {
    render(() => <WebtoolsTab tab={tab("tokens")} />);
    await waitFor(() => expect(screen.getByLabelText("Ask the agent to check and remove the unused tokens")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Ask the agent to check and remove the unused tokens"));
    await waitFor(() => expect(calls.asked).toHaveLength(1));
    expect(calls.asked[0]).toContain("--brand-old (defined at src/theme.css:3");
    expect(newRunPrefill()?.repoIds).toEqual(["app"]);
  });

  it("unused classes carry a status and a confidence, and the tool says it never deletes", async () => {
    render(() => <WebtoolsTab tab={tab("styles")} />);
    await waitFor(() => expect(screen.getByText(".card__legacy")).toBeTruthy());
    expect(screen.getByText("dynamic, unsure")).toBeTruthy();
    expect(screen.getAllByText(/ever deleted/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("Ask the agent to review the unused classes in src/Card.scss"));
    await waitFor(() => expect(calls.asked[0]).toContain(".card__legacy (line 14, unused, confidence high)"));
  });
});

describe("react checks and bundle", () => {
  it("explains each finding in plain language and labels the check as a heuristic", async () => {
    render(() => <WebtoolsTab tab={tab("react")} />);
    await waitFor(() => expect(screen.getByText("Images without alt text")).toBeTruthy());
    expect(screen.getByText(/Screen readers read the alt text aloud/)).toBeTruthy();
    expect(screen.getAllByText("Heuristic").length).toBeGreaterThan(0);
    expect(screen.getByText(/Dashboard: 338 lines/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Ask the agent to fix src/Hero.tsx line 9"));
    await waitFor(() => expect(calls.asked[0]).toContain("src/Hero.tsx:9"));
  });

  it("passes the size limits to the check", async () => {
    const seen: unknown[] = [];
    setWebtoolsApi({ ...api, react: async (r, o) => (seen.push(o), api.react(r, o)) });
    render(() => <WebtoolsTab tab={tab("react")} />);
    await waitFor(() => expect(screen.getByText("Images without alt text")).toBeTruthy());
    expect(seen).toHaveLength(1);
    fireEvent.input(screen.getByLabelText("Large from (lines)"), { target: { value: "120" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" }).at(-1)!);
    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    expect(seen[seen.length - 1]).toEqual({ maxLines: 120, maxProps: 10 });
  });

  it("shows the biggest files of an existing build and an estimate that says it is one", async () => {
    render(() => <WebtoolsTab tab={tab("bundle")} />);
    await waitFor(() => expect(screen.getByText("dist/assets/index-abc123.js")).toBeTruthy());
    expect(screen.getByText(/compressed \(estimate\)/)).toBeTruthy();
    expect(screen.getByText("469 KB")).toBeTruthy();
  });
});

describe("routes and Try it", () => {
  it("lists routes with their file and fills Try it from a click", async () => {
    render(() => <WebtoolsTab tab={tab("routes")} />);
    await waitFor(() => expect(screen.getByText("/api/users/:id")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Try GET /api/users/:id"));
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/api/users/:id");
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(calls.tryIt).toHaveLength(1));
    expect(calls.tryIt[0]).toEqual({ port: 5173, method: "GET", path: "/api/users/:id", headers: [], body: undefined });
    await waitFor(() => expect(screen.getByTestId("wt-response").textContent).toContain("200 OK"));
    expect(screen.getByLabelText("Response body").textContent).toBe('{"ok":true}');
  });

  it("never sends anything that is not a plain path", async () => {
    render(() => <WebtoolsTab tab={tab("routes")} />);
    await waitFor(() => expect(screen.getByLabelText("Path")).toBeTruthy());
    for (const bad of ["http://evil.test/x", "//evil.test", "no-slash", "/a b"]) {
      fireEvent.input(screen.getByLabelText("Path"), { target: { value: bad } });
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/starts with one slash/));
    }
    expect(calls.tryIt).toHaveLength(0);
  });

  it("without a running dev server there is nothing to send to", async () => {
    setWebtoolsApi({ ...api, servers: async () => ({ available: true, servers: [] }) });
    render(() => <WebtoolsTab tab={tab("routes")} />);
    await waitFor(() => expect(screen.getByText("No dev server is running")).toBeTruthy());
    expect(screen.queryByText("Send")).toBeNull();
  });

  it("says why when this computer cannot list listening ports (no lsof)", async () => {
    setWebtoolsApi({ ...api, servers: async () => ({ available: false, servers: [] }) });
    render(() => <WebtoolsTab tab={tab("routes")} />);
    await waitFor(() => expect(screen.getByText("Try it cannot check which ports are yours")).toBeTruthy());
    expect(screen.queryByText("Send")).toBeNull();
  });

  it("asks for the servers of the repository it is shown for", async () => {
    const asked: string[] = [];
    setWebtoolsApi({ ...api, servers: async (id) => (asked.push(id), api.servers(id)) });
    render(() => <WebtoolsTab tab={tab("routes")} />);
    await waitFor(() => expect(asked).toEqual(["app"]));
  });

  it("sends headers and body only when given and shows a redirect without following it", async () => {
    setWebtoolsApi({
      ...api,
      tryIt: async (_id, r) => (calls.tryIt.push(r), { status: 302, reason: "Found", headers: [["location", "http://evil.test/"]], body: "", bodyTruncated: false, binary: false, bytes: 0, millis: 3, host: "127.0.0.1", redirect: "http://evil.test/" }),
    });
    render(() => <WebtoolsTab tab={tab("routes")} />);
    await waitFor(() => expect(screen.getByLabelText("Path")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Headers (one per line, Name: value)"), { target: { value: "X-Test: 1" } });
    fireEvent.input(screen.getByLabelText("Body"), { target: { value: "{}" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(calls.tryIt[0]).toMatchObject({ headers: [["X-Test", "1"]], body: "{}" }));
    await waitFor(() => expect(screen.getByText(/It was not followed/)).toBeTruthy());
    expect(calls.tryIt).toHaveLength(1);
  });
});

describe("env and dependencies", () => {
  it("shows names only and explains each problem", async () => {
    setWebtoolsApi({
      ...api,
      env: async () => ({
        dirs: [{ dir: "", files: [{ path: ".env", example: false, unprotected: true, tracked: false, keys: 3 }], missing: [{ key: "STRIPE_KEY", example: ".env.example" }], undocumented: ["DEBUG_SQL"], noExample: false, noEnv: false }],
        skipped: [],
      }),
    });
    render(() => <WebtoolsTab tab={tab("env")} />);
    await waitFor(() => expect(screen.getByText("STRIPE_KEY")).toBeTruthy());
    expect(screen.getByText("DEBUG_SQL")).toBeTruthy();
    expect(screen.getByText("not git-ignored")).toBeTruthy();
    expect(screen.getByText("names only")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Ask the agent to fix the env files in repository root"));
    await waitFor(() => expect(calls.asked[0]).toMatch(/STRIPE_KEY/));
    expect(calls.asked[0]).not.toMatch(/=\S/);
  });

  it("checks dependencies only after the person confirmed that it uses the network", async () => {
    render(() => <WebtoolsTab tab={tab("deps")} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Check dependencies" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Check dependencies" }));
    await waitFor(() => expect(screen.getByText("Check dependencies over the network?")).toBeTruthy());
    expect(calls.deps).toHaveLength(0);
    fireEvent.click(screen.getByText("Cancel"));
    expect(calls.deps).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Check dependencies" }));
    await waitFor(() => expect(screen.getByText("Check now")).toBeTruthy());
    fireEvent.click(screen.getByText("Check now"));
    await waitFor(() => expect(calls.deps).toEqual([true]));
    await waitFor(() => expect(screen.getByText("react")).toBeTruthy());
    expect(screen.getByText("18.2.0 → 19.1.0")).toBeTruthy();
    expect(screen.getByText("semver")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Ask the agent to upgrade the packages safely"));
    await waitFor(() => expect(calls.asked[0]).toContain("react: 18.2.0 -> latest 19.1.0 (major)"));
    expect(calls.asked[0]).toMatch(/Do not run npm audit fix --force/);
  });

  it("a project of another package manager gets a friendly note, not a button", async () => {
    setWebtoolsApi({ ...api, detect: async () => detect({ packages: [{ dir: "", manager: "pnpm" }] }) });
    render(() => <WebtoolsTab tab={tab("deps")} />);
    await waitFor(() => expect(screen.getByText(/uses pnpm/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Check dependencies" })).toBeNull();
  });

  it("shows why the check failed", async () => {
    setWebtoolsApi({ ...api, depsCheck: async () => Promise.reject({ code: "npmMissing", message: "could not start npm" }) });
    render(() => <WebtoolsTab tab={tab("deps")} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Check dependencies" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Check dependencies" }));
    fireEvent.click(await screen.findByText("Check now"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not start npm"));
  });
});

describe("the extra", () => {
  afterEach(() => {
    setWebtoolsEnabled(true);
    resetCommands();
    resetSettings();
  });

  it("registers a tab type and one command per tool, and removes them when switched off", async () => {
    register();
    expect(getTabType("webtools")).toBeDefined();
    for (const id of ["webtools.open", "webtools.tokens", "webtools.styles", "webtools.react", "webtools.bundle", "webtools.routes", "webtools.env", "webtools.deps"]) expect(getCommand(id), id).toBeDefined();
    setWebtoolsEnabled(false);
    await waitFor(() => expect(getCommand("webtools.open")).toBeUndefined());
    setWebtoolsEnabled(true);
    await waitFor(() => expect(getCommand("webtools.open")).toBeDefined());
    expect(await execute("webtools.routes")).toBe(true);
  });
});
