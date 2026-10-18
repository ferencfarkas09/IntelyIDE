// Backend of the DeepPattern screen: the `deeppattern_*` commands in the app, a fixture in a plain browser. Tests swap it with `setDeepPatternApi`.
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { DpReport, DpStatus } from "./types";

export interface DeepPatternApi {
  status(): Promise<DpStatus>;
  doctor(): Promise<DpReport>;
  openExternal(url: string): Promise<void>;
}

/** The public source of the engine and its installer. */
export const PROJECT_URL = "https://github.com/deeppatternai/decision-engine";

const tauriApi: DeepPatternApi = {
  status: () => call("deeppattern_status", {}),
  doctor: () => call("deeppattern_doctor", {}),
  openExternal: (url) => call("open_external", { url }),
};

let override: DeepPatternApi | undefined;
export const setDeepPatternApi = (api: DeepPatternApi | undefined): void => void (override = api);

export function deepPatternApi(): DeepPatternApi {
  return override ?? (inTauri() ? tauriApi : fixture);
}

/** An activated engine, as the screenshots and the browser preview show it. */
const fixture: DeepPatternApi = {
  status: async () => ({
    installed: true,
    activated: true,
    endpointHost: "de.example.com",
    recoveryRequired: false,
    root: "/Users/me/.deeppattern/decision-engine",
    doctor: true,
    commands: {
      install: "git clone https://github.com/deeppatternai/decision-engine ~/decision-engine && cd ~/decision-engine && bash ./dp-install.sh",
      activate: "cd '/Users/me/.deeppattern/decision-engine' && python3 -m installer.permanent_setup",
      doctor: "bash '/Users/me/.deeppattern/decision-engine/dp-doctor.sh'",
    },
  }),
  doctor: async () => ({
    verdict: "warn",
    exitCode: 0,
    tookMs: 1840,
    lines: [
      { tone: "ok", text: "PASS Python 3.12.7 (private runtime)" },
      { tone: "ok", text: "PASS Skills linked into Claude Code" },
      { tone: "ok", text: "PASS Pop-up window backend can open a window" },
      { tone: "warn", text: "WARN LibreOffice not found (optional, used for document previews)" },
      { tone: "ok", text: "PASS Device activated (endpoint set, device credential set)" },
    ],
  }),
  openExternal: async () => {},
};
