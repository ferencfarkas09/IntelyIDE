// The Needs-You radar window: a small always-on-top window (label "radar") that lists the runs waiting on the person. The app
// side is `src-tauri/src/modules/radar.rs`; in a plain browser (mock IPC) the radar opens as a popup and "Open" travels over a
// BroadcastChannel, so the flow can be tried without the desktop shell. Tests swap the backend with `setRadarApi`.
import type { Unsubscribe } from "../../../ipc";
import { call, subscribe } from "../../../ipc/rpc";
import { inTauri } from "../../l10n/api";

export interface RadarApi {
  /** Shows the radar window (creates it the first time). */
  open(): Promise<void>;
  close(): Promise<void>;
  /** From the radar: bring the main window forward with this run selected. */
  openRun(agentId: string): Promise<void>;
  /** In the main window: a run the radar asked to open. */
  onOpenRun(cb: (agentId: string) => void): Unsubscribe;
}

const tauriApi: RadarApi = {
  open: () => call("radar_open"),
  close: () => call("radar_close"),
  openRun: (agentId) => call("radar_open_run", { agentId }),
  onOpenRun: (cb) => subscribe<{ agentId: string }>("radar:open-run", (e) => typeof e?.agentId === "string" && cb(e.agentId)),
};

const CHANNEL = "intely-radar";

export function createBrowserRadar(): RadarApi {
  const channel = (): BroadcastChannel | undefined => (typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(CHANNEL));
  return {
    async open() {
      const url = new URL(location.href);
      url.search = "";
      url.searchParams.set("widget", "radar");
      globalThis.open?.(url.toString(), "radar", "popup,width=380,height=560");
    },
    async close() {
      globalThis.close?.();
    },
    async openRun(agentId) {
      const c = channel();
      c?.postMessage({ agentId });
      c?.close();
    },
    onOpenRun(cb) {
      const c = channel();
      if (!c) return () => {};
      c.onmessage = (e: MessageEvent<{ agentId?: unknown }>) => typeof e.data?.agentId === "string" && cb(e.data.agentId);
      return () => c.close();
    },
  };
}

let override: RadarApi | undefined;
export const setRadarApi = (api: RadarApi | undefined): void => void (override = api);

let browser: RadarApi | undefined;
export function radarApi(): RadarApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (browser ??= createBrowserRadar());
}
