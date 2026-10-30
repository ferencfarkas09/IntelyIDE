// Backend of the React Native panel: `devices_*` commands in the app, an in-memory fixture in a plain browser and in tests.
// Metro and the native builds are not here: they are package.json scripts started through `ipc.run` (the Run panel's runner).
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { DeviceList, LogChunk, LogEntry, Platform, ProjectInfo } from "./types";

export interface DevicesApi {
  /** The status card; null when the repository is not a React Native or Expo app. */
  detect(repoId: string): Promise<ProjectInfo | null>;
  list(repoId: string): Promise<DeviceList>;
  /** `kind` "ios": `id` is the simulator UDID; "android": the AVD name. */
  boot(repoId: string, kind: Platform, id: string): Promise<void>;
  /** `kind` "ios": the UDID; "android": the adb serial of an emulator. */
  shutdown(repoId: string, kind: Platform, id: string): Promise<void>;
  logStart(repoId: string, platform: Platform, device?: string): Promise<void>;
  logStop(platform: Platform): Promise<void>;
  logClear(platform: Platform): Promise<void>;
  logs(platform: Platform, fromSeq: number): Promise<LogChunk>;
  /** Asks the running Metro server of the Run panel to reload the app (loopback only). */
  reload(serverId: string): Promise<void>;
}

const tauriApi: DevicesApi = {
  detect: (repoId) => call("devices_detect", { repoId }),
  list: (repoId) => call("devices_list", { repoId }),
  boot: (repoId, kind, id) => call("devices_boot", { repoId, kind, id }),
  shutdown: (repoId, kind, id) => call("devices_shutdown", { repoId, kind, id }),
  logStart: (repoId, platform, device) => call("devices_log_start", { repoId, platform, device: device ?? null }),
  logStop: (platform) => call("devices_log_stop", { platform }),
  logClear: (platform) => call("devices_log_clear", { platform }),
  logs: (platform, fromSeq) => call("devices_logs", { platform, fromSeq }),
  reload: (serverId) => call("devices_reload", { serverId }),
};

let override: DevicesApi | undefined;
export const setDevicesApi = (api: DevicesApi | undefined): void => void (override = api);

let mock: DevicesApi | undefined;
export function devicesApi(): DevicesApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockDevices());
}

export const MOCK_PROJECT: ProjectInfo = {
  kind: "expo",
  name: "Demo App",
  rnVersion: "0.76.3",
  expoVersion: "52.0.11",
  newArch: true,
  hermes: true,
  packageManager: "npm",
  hasIos: true,
  hasAndroid: true,
  pods: "installed",
  androidSdk: "/Users/demo/Library/Android/sdk",
  metroScript: "start",
  iosScript: "ios",
  androidScript: "android",
  iosProcess: "DemoApp",
  notes: [],
};

const MOCK_LOG: Record<Platform, LogEntry[]> = {
  ios: [
    { level: "info", text: '2024-05-01 10:00:00.100 Df  DemoApp[1234:5678] [javascript] Running "DemoApp"' },
    { level: "warn", text: "2024-05-01 10:00:02.300 Df  DemoApp[1234:5678] [javascript] WARN  Require cycle: a.js -> b.js -> a.js" },
    { level: "error", text: "2024-05-01 10:00:03.400 E   DemoApp[1234:5678] [javascript] Invariant Violation: Native module cannot be null." },
  ],
  android: [
    { level: "info", text: '05-01 10:00:00.100  1234  5678 I ReactNativeJS: Running "DemoApp"' },
    { level: "warn", text: "05-01 10:00:01.200  1234  5678 W ReactNativeJS: Require cycle: a.js -> b.js" },
    { level: "error", text: "05-01 10:00:02.300  1234  5678 E ReactNativeJS: TypeError: undefined is not a function" },
  ],
};

/** A phone-shaped fixture: two simulators, an emulator, a connected phone. `?delay=0`-style speed: everything resolves at once. */
export function createMockDevices(project: ProjectInfo | null = MOCK_PROJECT): DevicesApi {
  const booted = new Set<string>(["6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01"]);
  const streams = new Map<Platform, { running: boolean; sent: number }>();
  return {
    detect: async () => (project ? structuredClone(project) : null),
    list: async () => ({
      ios: [
        { udid: "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01", name: "iPhone 15", runtime: "iOS 17.5", state: booted.has("6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01") ? "booted" : "shutdown" },
        { udid: "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E02", name: "iPhone 15 Pro", runtime: "iOS 17.5", state: booted.has("6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E02") ? "booted" : "shutdown" },
      ],
      avds: ["Pixel_7_API_34"],
      android: [
        { serial: "emulator-5554", state: "device", model: "sdk gphone64 arm64", product: "sdk_gphone64_arm64", isEmulator: true },
        { serial: "R58M12ABCDE", state: "device", model: "SM G973F", product: "beyond1", isEmulator: false },
      ],
      tools: [
        { name: "xcrun", available: true, hint: null },
        { name: "adb", available: true, hint: null },
        { name: "emulator", available: true, hint: null },
      ],
      notes: [],
    }),
    boot: async (_r, kind, id) => void (kind === "ios" && booted.add(id)),
    shutdown: async (_r, kind, id) => void (kind === "ios" && booted.delete(id)),
    logStart: async (_r, platform) => void streams.set(platform, { running: true, sent: 0 }),
    logStop: async (platform) => void (streams.get(platform) && (streams.get(platform)!.running = false)),
    logClear: async () => {},
    logs: async (platform, fromSeq) => {
      const s = streams.get(platform);
      const all = MOCK_LOG[platform];
      const entries = s ? all.slice(Math.min(fromSeq, all.length)) : [];
      return { platform, startSeq: Math.min(fromSeq, all.length), entries, reset: false, running: !!s?.running, exitCode: null, dropped: 0 };
    },
    reload: async () => {},
  };
}
