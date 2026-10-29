// Backend of the Web and Node helpers: the `webtools_*` commands in the app, an in-memory fixture in a plain browser (a React
// app with SCSS and an Express backend) so the panels can be shown and tested.
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { AuditReport, BundleReport, Detect, DepsReport, EnvReport, LiveServer, OutdatedPkg, ReactOptions, ReactReport, RouteMap, RuleMatch, RuleQuery, TokensReport, TryRequest, TryResponse, UnusedReport } from "./types";

export interface WebtoolsApi {
  detect(repoId: string): Promise<Detect>;
  tokens(repoId: string): Promise<TokensReport>;
  unusedStyles(repoId: string): Promise<UnusedReport>;
  react(repoId: string, opts?: ReactOptions): Promise<ReactReport>;
  bundle(repoId: string): Promise<BundleReport>;
  routes(repoId: string): Promise<RouteMap>;
  env(repoId: string): Promise<EnvReport>;
  findRule(repoId: string, query: RuleQuery): Promise<RuleMatch[]>;
  /** The live dev servers started from the Scripts panel, with the ports they listen on. */
  servers(): Promise<LiveServer[]>;
  /** One request to 127.0.0.1 / ::1 on the port of a live dev server. */
  tryIt(req: TryRequest): Promise<TryResponse>;
  /** `npm outdated` + `npm audit`: uses the network, so `confirmed` must be true. */
  depsCheck(repoId: string, dir: string, confirmed: boolean): Promise<DepsReport>;
}

const tauriApi: WebtoolsApi = {
  detect: (repoId) => call("webtools_detect", { repoId }),
  tokens: (repoId) => call("webtools_tokens", { repoId }),
  unusedStyles: (repoId) => call("webtools_unused_styles", { repoId }),
  react: (repoId, opts) => call("webtools_react", { repoId, maxLines: opts?.maxLines ?? null, maxProps: opts?.maxProps ?? null }),
  bundle: (repoId) => call("webtools_bundle", { repoId }),
  routes: (repoId) => call("webtools_routes", { repoId }),
  env: (repoId) => call("webtools_env", { repoId }),
  findRule: (repoId, query) => call("webtools_find_rule", { repoId, query }),
  servers: () => call("webtools_servers"),
  tryIt: (request) => call("webtools_try", { request }),
  depsCheck: (repoId, dir, confirmed) => call("webtools_deps_check", { repoId, dir, confirmed }),
};

let override: WebtoolsApi | undefined;
export const setWebtoolsApi = (api: WebtoolsApi | undefined): void => void (override = api);

let mock: WebtoolsApi | undefined;
export function webtoolsApi(): WebtoolsApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockWebtools());
}

const NO_REACT: ReactReport = { findings: [], filesScanned: 0, truncated: false, skipped: [] };

/** The fixture is a React + SCSS app with an Express API, one live dev server on 5173, and a build output. */
export function createMockWebtools(): WebtoolsApi {
  const outdated: OutdatedPkg[] = [
    { name: "react", current: "18.2.0", wanted: "18.3.1", latest: "19.1.0", jump: "major", dev: false },
    { name: "vite", current: "5.0.0", wanted: "5.4.2", latest: "5.4.2", jump: "minor", dev: true },
  ];
  const audit: AuditReport = { info: 0, low: 0, moderate: 1, high: 0, critical: 0, items: [{ name: "semver", severity: "moderate", direct: false, fix: "safe", title: "Regular expression denial of service" }] };
  return {
    detect: async () => ({ css: true, scss: true, react: true, reactNative: false, backends: ["express"], env: true, bundle: true, packages: [{ dir: "", manager: "npm" }] }),
    tokens: async () => ({
      tokens: [
        { name: "--brand", kind: "custom", value: "#5b8def", file: "src/theme.css", line: 2, definitions: 1, uses: 12, mentions: 0, unused: false, confidence: "high", swatch: "#5b8def" },
        { name: "--brand-old", kind: "custom", value: "#5b8def", file: "src/theme.css", line: 3, definitions: 1, uses: 0, mentions: 0, unused: true, confidence: "high", swatch: "#5b8def" },
        { name: "$gap", kind: "scss", value: "8px", file: "src/_vars.scss", line: 1, definitions: 1, uses: 4, mentions: 0, unused: false, confidence: "high", swatch: null },
        { name: "$spacers", kind: "scssMap", value: "(sm: 4px, md: 8px)", file: "src/_vars.scss", line: 2, definitions: 1, uses: 0, mentions: 0, unused: true, confidence: "medium", swatch: null },
      ],
      hardcoded: [{ file: "src/Card.scss", line: 7, prop: "color", value: "#5b8def", token: "--brand", suggestion: "var(--brand)" }],
      duplicates: [{ value: "#5b8def", swatch: "#5b8def", tokens: ["--brand", "--brand-old"], hardcoded: 0, examples: [] }],
      swatches: [
        { name: "--brand", value: "#5b8def" },
        { name: "--brand-old", value: "#5b8def" },
      ],
      filesScanned: 24,
      dynamicNames: false,
      truncated: false,
      skipped: [],
    }),
    unusedStyles: async () => ({
      files: [{ path: "src/Card.scss", module: false, notImported: false, classes: [{ name: "card__legacy", line: 14, status: "unused", confidence: "high" }, { name: "btn-primary", line: 30, status: "dynamic", confidence: "low" }] }],
      classesChecked: 31,
      filesScanned: 24,
      dynamicClasses: true,
      truncated: false,
      skipped: [],
    }),
    react: async (_repoId, opts) => ({
      ...NO_REACT,
      filesScanned: 12,
      findings: [
        { rule: "imgAlt", file: "src/Hero.tsx", line: 9, detail: "img", count: 0, confidence: "high" },
        { rule: "noAccessibleName", file: "src/Nav.tsx", line: 21, detail: "button", count: 0, confidence: "medium" },
        { rule: "largeComponent", file: "src/Dashboard.tsx", line: 4, detail: "Dashboard", count: Math.max(opts?.maxLines ?? 200, 200) + 138, confidence: "medium" },
      ],
    }),
    bundle: async () => ({
      dirs: [
        {
          dir: "dist",
          totalSize: 612_000,
          totalGzipEstimate: 196_000,
          files: 9,
          mapSize: 1_200_000,
          top: [
            { path: "dist/assets/index-abc123.js", size: 480_000, gzipEstimate: 153_600, kind: "js" },
            { path: "dist/assets/logo.png", size: 62_000, gzipEstimate: 62_000, kind: "image" },
          ],
          byKind: [{ kind: "js", size: 480_000, count: 3 }],
          newest: 1_760_000_000,
        },
      ],
      truncated: false,
    }),
    routes: async () => ({
      routes: [
        { framework: "express", method: "GET", path: "/api/users", file: "server/routes/users.js", line: 8 },
        { framework: "express", method: "POST", path: "/api/users", file: "server/routes/users.js", line: 21 },
        { framework: "express", method: "GET", path: "/api/users/:id", file: "server/routes/users.js", line: 34 },
      ],
      frameworks: ["express"],
      filesScanned: 18,
      truncated: false,
      skipped: [],
    }),
    env: async () => ({
      dirs: [
        {
          dir: "",
          files: [
            { path: ".env", example: false, unprotected: false, tracked: false, keys: 3 },
            { path: ".env.example", example: true, unprotected: false, tracked: false, keys: 4 },
          ],
          missing: [{ key: "STRIPE_KEY", example: ".env.example" }],
          undocumented: ["DEBUG_SQL"],
          noExample: false,
          noEnv: false,
        },
      ],
      skipped: [],
    }),
    findRule: async (_repoId, q) => (q.classes.includes("card") ? [{ file: "src/Card.scss", line: 3, selector: ".card", score: 10, why: ["class"] }] : []),
    servers: async () => [{ id: "mock:npm:dev", repoId: "mock", runner: "npm run dev", ports: [5173] }],
    tryIt: async (req) => {
      if (!(await Promise.resolve([5173])).includes(req.port)) return Promise.reject({ code: "notAllowed", message: "Try it only reaches a dev server that was started from the Scripts panel, on its own port" });
      return { status: 200, reason: "OK", headers: [["content-type", "application/json"]], body: '{"ok":true}', bodyTruncated: false, binary: false, bytes: 11, millis: 4, host: "127.0.0.1", redirect: null };
    },
    depsCheck: async (_repoId, _dir, confirmed) => {
      if (!confirmed) return Promise.reject({ code: "confirmRequired", message: "needs a confirmation" });
      return { outdated, audit, notes: [] };
    },
  };
}
