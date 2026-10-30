// Backend of the Mobile health panel: `mobilehealth_detect` / `mobilehealth_scan` in the app (both only read), an in-memory
// report in a plain browser so the panel can be shown and tested.
import { createSignal } from "solid-js";
import { call } from "../../ipc/rpc";
import { repos } from "../../store/workspace";
import { inTauri } from "../l10n/api";
import type { RepoHealth } from "./types";

export interface MobileHealthApi {
  /** The ids of the repositories that hold an iOS or Android project (cheap: looks at folder names). */
  detect(): Promise<string[]>;
  /** The report of one repository, or `null` when it holds no mobile project. One call per repository: a slow one holds up no other. */
  scan(repoId: string): Promise<RepoHealth | null>;
}

const tauriApi: MobileHealthApi = {
  detect: () => call("mobilehealth_detect"),
  scan: (repoId) => call("mobilehealth_scan_repo", { repoId }),
};

let override: MobileHealthApi | undefined;
export const setMobileHealthApi = (api: MobileHealthApi | undefined): void => void (override = api);

let mock: MobileHealthApi | undefined;
export function mobileHealthApi(): MobileHealthApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockMobileHealth(() => repos().map((r) => r.id)));
}

/** The repositories that hold a mobile project: gates the palette command and the tab. */
const [detected, setDetected] = createSignal<string[]>([]);
export const mobileRepos = detected;
export async function refreshDetected(): Promise<void> {
  try {
    setDetected(await mobileHealthApi().detect());
  } catch {
    setDetected([]);
  }
}

/** A React Native app with a few honest problems, for the first repository of the workspace. */
export function sampleReport(repoId: string): RepoHealth {
  const f = (id: string, severity: "error" | "warn" | "info", platform: "ios" | "android" | "cross", file: string | null, line: number | null, params: Record<string, string> = {}, confidence: "high" | "medium" | "low" | null = null) => ({
    id,
    platform,
    severity,
    file,
    line,
    confidence,
    params,
    prompt: `Fix ${id} in ${file ?? "the project"}.`,
  });
  return {
    repoId,
    detected: true,
    skipped: [],
    data: { compat: "2026-10-29", store: "2026-10-29" },
    projects: [
      {
        path: "",
        ios: true,
        android: true,
        reactNative: true,
        expo: false,
        flutter: false,
        facts: [
          { key: "ios.version", value: "1.2.0", file: "ios/App.xcodeproj/project.pbxproj", line: 310 },
          { key: "ios.bundleId", value: "com.acme.demo", file: "ios/App.xcodeproj/project.pbxproj", line: 312 },
          { key: "android.versionName", value: "1.3.0", file: "android/app/build.gradle", line: 12 },
          { key: "android.targetSdk", value: "34", file: "android/app/build.gradle", line: 11 },
        ],
        findings: [
          f("android.signing.releaseUsesDebug", "error", "android", "android/app/build.gradle", 41),
          f("ios.team.empty", "warn", "ios", "ios/App.xcodeproj/project.pbxproj", 318, { target: "App", configuration: "Release" }),
          f("ios.permission.missing", "warn", "ios", "ios/App/Info.plist", null, { permission: "camera", key: "NSCameraUsageDescription", evidence: "package:react-native-vision-camera" }, "medium"),
          f("cross.version.mismatch", "info", "cross", null, null, { ios: "1.2.0", android: "1.3.0" }),
        ],
        checklist: [
          { id: "ios.privacyManifest", platform: "ios", status: "missing", file: null, params: {}, prompt: "Add a privacy manifest." },
          { id: "ios.icon", platform: "ios", status: "ok", file: "ios/App/Images.xcassets/AppIcon.appiconset/Contents.json", params: {}, prompt: null },
          { id: "android.targetApi", platform: "android", status: "missing", file: null, params: { target: "34", level: "36", reviewed: "2026-10-29" }, prompt: "Raise targetSdk." },
        ],
      },
    ],
  };
}

export function createMockMobileHealth(repoIds: () => string[]): MobileHealthApi {
  const first = (): string[] => repoIds().slice(0, 1);
  return {
    detect: async () => first(),
    scan: async (repoId) => (first().includes(repoId) ? sampleReport(repoId) : null),
  };
}
