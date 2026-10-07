// Backend of the component preview: the `preview_component_*` commands in the app, and in a plain browser (mock UI, Playwright,
// tests) a stand-in that points the frame at a harness the developer started by hand (`?harness=http://127.0.0.1:<port>`).
import { call } from "../../ipc/rpc";
import { validatePreviewUrl } from "./logic";

export interface HarnessInfo {
  id: string;
  /** `http://127.0.0.1:<port>/` */
  url: string;
  port: number;
  /** Whose esbuild bundles the component: the repo's own copy or the IDE's. */
  engine: "repo" | "ide";
  esbuild: string;
  react: string;
  installed: { redux: boolean; mui: boolean; styled: boolean; router: boolean };
  /** What the component's own imports already use: only these providers are bundled. */
  uses: { redux: boolean; mui: boolean; styled: boolean; router: boolean };
  buildOk: boolean;
  ms: number;
}

export interface ComponentApi {
  start(repoId: string, file: string, exportName: string): Promise<HarnessInfo>;
  release(id: string): Promise<void>;
  log(id: string): Promise<string[]>;
}

const inTauri = (): boolean => typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

const tauriApi: ComponentApi = {
  start: (repoId, file, exportName) => call("preview_component_start", { repoId, file, export: exportName }),
  release: (id) => call("preview_component_release", { id }),
  log: (id) => call("preview_component_log", { id }),
};

/** No Rust here: the frame loads the loopback harness named in the page address, if any. */
export function createMockComponentApi(search: () => string = () => globalThis.location?.search ?? ""): ComponentApi {
  return {
    async start(_repoId, file) {
      const raw = new URLSearchParams(search()).get("harness") ?? "";
      const r = validatePreviewUrl(raw, globalThis.location?.origin);
      if (!r.ok) throw { code: "mock", message: `The browser mock has no harness process. Start scripts/preview/harness/server.mjs yourself and open this page with ?harness=http://127.0.0.1:<port> (${file}).` };
      return {
        id: `mock-${r.port}`,
        url: `${r.origin}/`,
        port: r.port,
        engine: "ide",
        esbuild: "0.28.2",
        react: "18.3.1",
        installed: { redux: true, mui: true, styled: true, router: true },
        uses: { redux: false, mui: false, styled: false, router: false },
        buildOk: true,
        ms: 0,
      };
    },
    async release() {},
    async log() {
      return [];
    },
  };
}

let override: ComponentApi | undefined;
export const setComponentApi = (api: ComponentApi | undefined): void => void (override = api);

let mock: ComponentApi | undefined;
export function componentApi(): ComponentApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockComponentApi());
}
