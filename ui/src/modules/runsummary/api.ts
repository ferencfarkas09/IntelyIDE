// Backend of the run summary: `agentux_run_digest` (built from the event log and read-only git, no model) and the run
// catalog (`run_scripts`, names only) in the app; an in-memory fixture in a plain browser and in tests, which can swap the
// whole API with `setRunSummaryApi`.
import { ipc } from "../../ipc";
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { RunDigest, ScriptHint } from "./types";

export interface RunSummaryApi {
  /** The digest of a run; null when the run has no log. `refresh` rebuilds it instead of using the cached file. */
  digest(runId: string, refresh?: boolean): Promise<RunDigest | null>;
  /** The dev, start and test scripts of a repository (what is executed, e.g. `npm run dev`). */
  scripts(repoId: string): Promise<ScriptHint[]>;
}

const WANTED = new Set(["dev", "start", "test"]);

const tauriApi: RunSummaryApi = {
  digest: (runId, refresh) => call("agentux_run_digest", { runId, refresh: refresh ?? false }),
  scripts: async (repoId) => (await ipc.run.scripts(repoId)).scripts.filter((s) => WANTED.has(s.group)).map((s) => ({ group: s.group, runner: s.runner })),
};

let override: RunSummaryApi | undefined;
export const setRunSummaryApi = (api: RunSummaryApi | undefined): void => void (override = api);

let mock: RunSummaryApi | undefined;
export function runSummaryApi(): RunSummaryApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockRunSummary());
}

/** A React Native run of the fixture: screens, a style file, a test, the iOS and Android manifests, a new package and a curl. */
export function fixtureDigest(runId: string, repoId = "storefront"): RunDigest {
  return {
    version: 1,
    runId,
    title: "Show the store's location on a map",
    status: "done",
    startedMs: 1_790_000_000_000,
    endedMs: 1_790_000_600_000,
    generatedMs: 1_790_000_601_000,
    fingerprint: { size: 48_210, mtimeMs: 1_790_000_600_000 },
    fileCount: 9,
    created: 3,
    modified: 6,
    deleted: 0,
    additions: 214,
    deletions: 31,
    groups: [
      { purpose: "ui", created: 2, modified: 2, deleted: 0, examples: ["src/screens/MapScreen.tsx", "src/components/StorePin.tsx", "src/navigation.tsx"] },
      { purpose: "styles", created: 0, modified: 1, deleted: 0, examples: ["src/theme/map.styles.ts"] },
      { purpose: "tests", created: 1, modified: 0, deleted: 0, examples: ["src/screens/MapScreen.test.tsx"] },
      { purpose: "config", created: 0, modified: 2, deleted: 0, examples: ["ios/Storefront/Info.plist", "android/app/src/main/AndroidManifest.xml"] },
      { purpose: "dependencies", created: 0, modified: 1, deleted: 0, examples: ["package.json"] },
    ],
    repos: [{ repoId, source: "git", fileCount: 9, created: 3, modified: 6, deleted: 0, additions: 214, deletions: 31, purposes: ["ui", "styles", "tests", "config", "dependencies"], ios: true, android: true }],
    commands: [
      { text: "npx expo install react-native-maps", failed: false },
      { text: "curl -s https://maps.example.com/v1/geocode?key=***", failed: false },
      { text: "npm test -- MapScreen", failed: true, exitCode: 1 },
    ],
    commandCount: 3,
    decisions: [
      { kind: "plan", text: "Add a map screen with a pin for the store", done: false },
      { kind: "todo", text: "Ask for the location permission", done: true },
      { kind: "final", text: "The store page now opens a map with the store's pin.", done: false },
    ],
    checks: [
      { code: "reinstall", repoIds: [repoId] },
      { code: "devServer", repoIds: [repoId] },
      { code: "iosBuild", repoIds: [repoId] },
      { code: "androidBuild", repoIds: [repoId] },
      { code: "runTests", repoIds: [repoId] },
    ],
    risks: [
      { code: "permissionsTouched", count: 2, evidence: ["ios/Storefront/Info.plist", "android/app/src/main/AndroidManifest.xml"] },
      { code: "newDependencies", count: 1, evidence: ["react-native-maps"] },
      { code: "networkCalls", count: 1, evidence: ["maps.example.com"] },
    ],
    failureCount: 0,
    failures: [],
    needsYou: 0,
    truncated: false,
  };
}

export function createMockRunSummary(opts: { digest?: (runId: string) => RunDigest | null; scripts?: Record<string, ScriptHint[]> } = {}): RunSummaryApi {
  return {
    digest: async (runId) => (opts.digest ? opts.digest(runId) : fixtureDigest(runId)),
    scripts: async (repoId) => opts.scripts?.[repoId] ?? [{ group: "dev", runner: "npm run dev" }, { group: "test", runner: "npm test" }],
  };
}
