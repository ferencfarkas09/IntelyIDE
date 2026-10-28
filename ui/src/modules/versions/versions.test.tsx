import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { createMockVersions, setVersionsApi, type VersionsApi } from "./api";
import { bumpBuild, bumpRepo, bumpVersion, changesOf, isPlaceholder, nextValue, setAllVersions, validValue, versionValues } from "./logic";
import type { Change, Field, RepoVersions } from "./types";
import VersionsTab from "./VersionsTab";

installDomStubs();
afterEach(() => {
  cleanup();
  setVersionsApi(undefined);
});

const f = (key: string, role: Field["role"], value: string, path = "package.json"): Field => ({ id: `${path}#${key}`, path, kind: "packageJson", key, role, value, occurrences: 1, mixed: false, numeric: role === "build", companions: [] });
const repo = (fields: Field[]): RepoVersions => ({ repoId: "r", fields, truncated: false, skipped: [] });

describe("version arithmetic", () => {
  it("bumps like npm: patch, minor and major reset what is below", () => {
    expect(bumpVersion("3.88.7", "patch")).toBe("3.88.8");
    expect(bumpVersion("3.88.7", "minor")).toBe("3.89.0");
    expect(bumpVersion("3.88.7", "major")).toBe("4.0.0");
    expect(bumpVersion("0.9.0", "patch")).toBe("0.9.1");
  });

  it("keeps the number of parts for minor and major, and gains a third for a patch", () => {
    expect(bumpVersion("1.2", "minor")).toBe("1.3");
    expect(bumpVersion("1.2", "major")).toBe("2.0");
    expect(bumpVersion("1.2", "patch")).toBe("1.2.1");
    expect(bumpVersion("5", "major")).toBe("6");
    expect(bumpVersion("5", "minor")).toBe("5.1");
    expect(bumpVersion("5", "patch")).toBe("5.0.1");
  });

  it("finishes a pre-release instead of skipping past it, and drops build metadata", () => {
    expect(bumpVersion("1.2.3-beta.1", "patch")).toBe("1.2.3");
    expect(bumpVersion("1.3.0-beta.2", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.3.1-beta.2", "minor")).toBe("1.4.0");
    expect(bumpVersion("2.0.0-rc.1", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3-rc.1", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3+meta", "patch")).toBe("1.2.4");
  });

  it("refuses what is not numeric", () => {
    for (const v of ["", "latest", "1.x", "1.2.3.4", "v1.2.3", "1..2"]) expect(bumpVersion(v, "patch"), v).toBeUndefined();
  });

  it("counts a build number up, also a dotted one", () => {
    expect(bumpBuild("45")).toBe("46");
    expect(bumpBuild("9")).toBe("10");
    expect(bumpBuild("1.4")).toBe("1.5");
    expect(bumpBuild("abc")).toBeUndefined();
    expect(bumpBuild("9007199254740993")).toBe("9007199254740994");
  });

  it("never offers a value the file could not hold", () => {
    const bare = { ...f("version", "version", "1.5"), numeric: true };
    expect(nextValue(bare, "minor")).toBe("1.6"); // two parts stay two parts
    expect(nextValue(bare, "patch")).toBeUndefined(); // 1.5.1 is not a JSON number
    const xcode = { ...f("MARKETING_VERSION", "version", "1.0.0", "App.xcodeproj/project.pbxproj"), kind: "pbxproj" as const };
    expect(nextValue(xcode, "patch")).toBe("1.0.1");
    expect(nextValue(f("CURRENT_PROJECT_VERSION", "build", "007"), "build")).toBe("8"); // no leading zero is written back
  });

  it("lets a skipped field go back to what is on disk instead of keeping an earlier pending change", () => {
    const bare = { ...f("version", "version", "1.5"), numeric: true };
    const plain = f("name", "version", "2.4.1", "app/package.json");
    const r = repo([bare, plain]);
    const major = bumpRepo(r, "major", {});
    expect(major).toEqual({ "package.json#version": "2.0", "app/package.json#name": "3.0.0" });
    // Patch afterwards: the plain row moves on from its own value, the bare number cannot take 1.5.1 and is not left at the Major edit
    const after = bumpRepo(r, "patch", major);
    expect(after["package.json#version"]).toBeUndefined();
    expect(after["app/package.json#name"]).toBe("2.4.2");
    // a typed value on a row the button does not apply to is left alone
    expect(bumpRepo(r, "build", { "package.json#version": "9.9" })["package.json#version"]).toBe("9.9");
  });

  it("applies a button only to the fields it is meant for", () => {
    expect(nextValue(f("version", "version", "1.0.0"), "patch")).toBe("1.0.1");
    expect(nextValue(f("version", "version", "1.0.0"), "build")).toBeUndefined();
    expect(nextValue(f("CURRENT_PROJECT_VERSION", "build", "45"), "build")).toBe("46");
    expect(nextValue(f("CURRENT_PROJECT_VERSION", "build", "45"), "major")).toBeUndefined();
  });
});

describe("pending edits", () => {
  const r = repo([f("MARKETING_VERSION", "version", "1.2.3", "ios/App.xcodeproj/project.pbxproj"), f("CURRENT_PROJECT_VERSION", "build", "45", "ios/App.xcodeproj/project.pbxproj"), f("version", "version", "3.88.7")]);

  it("bumps each version field from its own value and leaves build numbers to their button", () => {
    const e = bumpRepo(r, "minor", {});
    expect(e).toEqual({ "ios/App.xcodeproj/project.pbxproj#MARKETING_VERSION": "1.3.0", "package.json#version": "3.89.0" });
    expect(bumpRepo(r, "build", e)["ios/App.xcodeproj/project.pbxproj#CURRENT_PROJECT_VERSION"]).toBe("46");
  });

  it("sets every version to one value without touching build numbers", () => {
    expect(setAllVersions(r, "4.0.0", {})).toEqual({ "ios/App.xcodeproj/project.pbxproj#MARKETING_VERSION": "4.0.0", "package.json#version": "4.0.0" });
  });

  it("turns edits into changes only where the value differs and is not empty", () => {
    const edits = { "package.json#version": "3.88.8", "ios/App.xcodeproj/project.pbxproj#MARKETING_VERSION": "1.2.3", "ios/App.xcodeproj/project.pbxproj#CURRENT_PROJECT_VERSION": "  " };
    expect(changesOf(r, edits)).toEqual([{ id: "package.json#version", from: "3.88.7", to: "3.88.8" }]);
  });

  it("tells whether the files of a repo agree", () => {
    expect(versionValues(r)).toHaveLength(2);
    expect(versionValues(repo([f("version", "version", "1.0.0"), f("v2", "version", "1.0.0", "b/package.json")]))).toEqual(["1.0.0"]);
  });

  it("leaves 0.0.0 placeholders alone: no bump, no set-all, and they do not make a repository look out of step", () => {
    const placeholder = f("version", "version", "0.0.0", "tools/package.json");
    const real = f("version", "version", "1.4.0");
    const r2 = repo([real, placeholder]);
    expect(isPlaceholder(placeholder)).toBe(true);
    expect(isPlaceholder(f("CURRENT_PROJECT_VERSION", "build", "0.0.0"))).toBe(false);
    expect(nextValue(placeholder, "patch")).toBeUndefined();
    expect(bumpRepo(r2, "patch", {})).toEqual({ "package.json#version": "1.4.1" });
    expect(setAllVersions(r2, "2.0.0", {})).toEqual({ "package.json#version": "2.0.0" });
    expect(versionValues(r2)).toEqual(["1.4.0"]);
    expect(changesOf(r2, { "tools/package.json#version": "0.1.0" })).toEqual([{ id: "tools/package.json#version", from: "0.0.0", to: "0.1.0" }]);
  });

  it("marks values the files would refuse", () => {
    expect(validValue(f("version", "version", "1.0.0"), "2.0.0-beta.1")).toBe(true);
    expect(validValue(f("version", "version", "1.0.0"), "../x")).toBe(false);
    expect(validValue(f("version", "version", "1.0.0"), "")).toBe(false);
    expect(validValue(f("b", "build", "1"), "12")).toBe(true);
    expect(validValue(f("b", "build", "1"), "1.x")).toBe(false);
  });

  it("refuses what a bare number, an Xcode project or a pubspec cannot hold", () => {
    const bare = { ...f("version", "version", "1.5"), numeric: true };
    expect(validValue(bare, "2.0")).toBe(true);
    expect(validValue(bare, "2.0.1")).toBe(false); // JSON: a number has one dot
    expect(validValue(bare, "2-beta")).toBe(false);
    expect(validValue(bare, "01.5")).toBe(false);
    expect(validValue(f("b", "build", "1"), "007")).toBe(false); // read as octal by Groovy
    expect(validValue({ ...f("b", "build", "1"), numeric: false }, "1.4")).toBe(true); // a quoted build string may be dotted
    expect(validValue(f("b", "build", "1"), "1.4")).toBe(false); // a bare build number may not
    expect(validValue({ ...f("MARKETING_VERSION", "version", "1.0", "App.xcodeproj/project.pbxproj"), kind: "pbxproj" }, "1.0+7")).toBe(false);
    expect(validValue({ ...f("version", "version", "1.0.0", "pubspec.yaml"), kind: "pubspec" }, "1.0.0+7")).toBe(false);
    expect(validValue(f("version", "version", "1.0.0"), "1.0.0+7")).toBe(true);
  });
});

const IDS = ["services", "web", "site"];
const fixture = (): VersionsApi => createMockVersions(() => IDS);

describe("<VersionsTab>", () => {
  it("lists every repository with its files, and writes nothing until Apply", async () => {
    const sent: { repo: string; changes: Change[] }[] = [];
    const api = fixture();
    setVersionsApi({ ...api, apply: async (repo, changes) => (sent.push({ repo, changes }), api.apply(repo, changes)) });
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByTestId("versions-repo-services")).toBeTruthy());
    expect(screen.getByTestId("versions-repo-web")).toBeTruthy();
    expect(screen.getByText("ios/App.xcodeproj/project.pbxproj")).toBeTruthy();
    expect(screen.getByText("android/app/build.gradle")).toBeTruthy();
    expect(screen.getByText("Xcode project")).toBeTruthy();
    expect(screen.getAllByText("3 places, not all alike")).toHaveLength(2);
    expect(screen.getByText(/also package-lock.json/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("services: Patch"));
    expect((screen.getByLabelText("services package.json version") as HTMLInputElement).value).toBe("3.88.8");
    await waitFor(() => expect(document.querySelector('pre[data-path="package-lock.json"]')).toBeTruthy());
    expect(sent).toHaveLength(0);
  });

  it("bumps every repository at once and applies each one separately", async () => {
    const sent: { repo: string; changes: Change[] }[] = [];
    const api = fixture();
    setVersionsApi({ ...api, apply: async (repo, changes) => (sent.push({ repo, changes }), api.apply(repo, changes)) });
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByTestId("versions-repo-web")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("All repositories: Minor"));
    expect((screen.getByLabelText("web package.json version") as HTMLInputElement).value).toBe("2.5.0");
    expect((screen.getByLabelText("site package.json version") as HTMLInputElement).value).toBe("0.10.0");
    await waitFor(() => expect(screen.getByText("Apply 7 changes")).toBeTruthy());
    fireEvent.click(screen.getByText("Apply 7 changes"));
    await waitFor(() => expect(sent.map((s) => s.repo).sort()).toEqual(["services", "site", "web"]));
    expect(sent.find((s) => s.repo === "web")!.changes).toEqual([{ id: "package.json#version", from: "2.4.1", to: "2.5.0" }]);
    // after writing, the panel reads the files again and nothing is pending
    await waitFor(() => expect(screen.getByText(/Nothing is committed or tagged/)).toBeTruthy());
    expect((screen.getByLabelText("web package.json version") as HTMLInputElement).value).toBe("2.5.0");
  });

  it("counts a build number up with its own button and sets all versions to one value", async () => {
    setVersionsApi(fixture());
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByTestId("versions-repo-services")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("services: Build +1"));
    expect((screen.getByLabelText("services android/app/build.gradle versionCode") as HTMLInputElement).value).toBe("13");
    expect((screen.getByLabelText("services ios/App.xcodeproj/project.pbxproj CURRENT_PROJECT_VERSION") as HTMLInputElement).value).toBe("46");
    expect((screen.getByLabelText("services package.json version") as HTMLInputElement).value).toBe("3.88.7");
    fireEvent.input(screen.getByLabelText("Set all versions of services to"), { target: { value: "4.0.0" } });
    fireEvent.click(screen.getByLabelText("Set all versions of services"));
    expect((screen.getByLabelText("services android/app/build.gradle versionName") as HTMLInputElement).value).toBe("4.0.0");
    expect((screen.getByLabelText("services package.json version") as HTMLInputElement).value).toBe("4.0.0");
  });

  it("marks a value the files would refuse and keeps Apply off", async () => {
    setVersionsApi(fixture());
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByTestId("versions-repo-web")).toBeTruthy());
    const input = screen.getByLabelText("web package.json version") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "../etc" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByText(/^Apply/).closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(input, { target: { value: "2.4.2" } });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    await waitFor(() => expect((screen.getByText(/^Apply/).closest("button") as HTMLButtonElement).disabled).toBe(false));
  });

  it("undoes the pending changes of one repository", async () => {
    setVersionsApi(fixture());
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByTestId("versions-repo-web")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("web: Major"));
    expect((screen.getByLabelText("web package.json version") as HTMLInputElement).value).toBe("3.0.0");
    fireEvent.click(screen.getByLabelText("Undo the pending changes of web"));
    expect((screen.getByLabelText("web package.json version") as HTMLInputElement).value).toBe("2.4.1");
  });

  it("shows a stale file as an error and keeps the pending values", async () => {
    const api = fixture();
    setVersionsApi({ ...api, apply: async () => Promise.reject({ code: "stale", message: "package.json changed since it was read" }) });
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByTestId("versions-repo-web")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("web: Patch"));
    await waitFor(() => expect((screen.getByText(/^Apply/).closest("button") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText(/^Apply/));
    await waitFor(() => expect(document.body.textContent).toContain("package.json changed since it was read"));
  });

  it("says why a row is refused, and does not call a whitespace-only change a change", async () => {
    setVersionsApi(fixture());
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByTestId("versions-repo-web")).toBeTruthy());
    const input = screen.getByLabelText("web package.json version") as HTMLInputElement;
    const row = input.closest(".ver__row") as HTMLElement;
    fireEvent.input(input, { target: { value: "2.4.1 " } });
    expect(row.hasAttribute("data-changed")).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    fireEvent.input(input, { target: { value: "../x" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("title")).toMatch(/cannot hold this value/);
  });

  it("names the repositories that have no version files and shows a read failure as text", async () => {
    setVersionsApi({ ...fixture(), scan: async () => [{ repoId: "docs", fields: [], truncated: false, skipped: [] }, { repoId: "web", fields: [f("version", "version", "1.0.0")], truncated: false, skipped: ["big/package.json is too large to read"] }] });
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByText(/No version files found in docs/)).toBeTruthy());
    expect(screen.getByText(/too large to read/)).toBeTruthy();
    cleanup();
    // a repository whose only file was left out is not "without version files" in silence: the reason is shown with its name
    setVersionsApi({ ...fixture(), scan: async () => [{ repoId: "docs", fields: [], truncated: false, skipped: ["package.json is too large to read"] }] });
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByText(/docs: package.json is too large to read/)).toBeTruthy());
    cleanup();
    setVersionsApi({ ...fixture(), scan: async () => Promise.reject({ code: "io", message: "disk gone" }) });
    render(() => <VersionsTab />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("disk gone"));
    // a failed read is not "no repository in this workspace"
    expect(screen.queryByText("No repository in this workspace")).toBeNull();
  });
});
