// Mirrors crates/webtools (serde camelCase).
export type Confidence = "high" | "medium" | "low";

export interface PackageDir {
  /** "" for the repository root. */
  dir: string;
  manager: "npm" | "pnpm" | "yarn" | "bun" | "none";
}

export interface Detect {
  css: boolean;
  scss: boolean;
  react: boolean;
  reactNative: boolean;
  backends: string[];
  env: boolean;
  bundle: boolean;
  packages: PackageDir[];
}

export type TokenKind = "custom" | "scss" | "scssMap" | "less";
export interface Token {
  name: string;
  kind: TokenKind;
  value: string;
  file: string;
  line: number;
  definitions: number;
  uses: number;
  mentions: number;
  unused: boolean;
  confidence: Confidence;
  swatch: string | null;
}
export interface HardCoded {
  file: string;
  line: number;
  prop: string;
  value: string;
  token: string;
  suggestion: string;
}
export interface DuplicateColor {
  value: string;
  swatch: string | null;
  tokens: string[];
  hardcoded: number;
  examples: string[];
}
export interface Swatch {
  name: string;
  value: string;
}
export interface TokensReport {
  tokens: Token[];
  hardcoded: HardCoded[];
  duplicates: DuplicateColor[];
  swatches: Swatch[];
  filesScanned: number;
  dynamicNames: boolean;
  truncated: boolean;
  skipped: string[];
}

export interface UnusedClass {
  name: string;
  line: number;
  status: "unused" | "dynamic";
  confidence: Confidence;
}
export interface StyleFile {
  path: string;
  module: boolean;
  notImported: boolean;
  classes: UnusedClass[];
}
export interface UnusedReport {
  files: StyleFile[];
  classesChecked: number;
  filesScanned: number;
  dynamicClasses: boolean;
  truncated: boolean;
  skipped: string[];
}

export type ReactRule = "imgAlt" | "noAccessibleName" | "inputLabel" | "clickNonInteractive" | "listKey" | "fragmentKey" | "largeComponent" | "manyProps";
export interface ReactFinding {
  rule: ReactRule;
  file: string;
  line: number;
  detail: string;
  count: number;
  confidence: Confidence;
}
export interface ReactReport {
  findings: ReactFinding[];
  filesScanned: number;
  truncated: boolean;
  skipped: string[];
}
export interface ReactOptions {
  maxLines?: number;
  maxProps?: number;
}

export interface Asset {
  path: string;
  size: number;
  gzipEstimate: number;
  kind: string;
}
export interface BundleDir {
  dir: string;
  totalSize: number;
  totalGzipEstimate: number;
  files: number;
  mapSize: number;
  top: Asset[];
  byKind: { kind: string; size: number; count: number }[];
  newest: number;
}
export interface BundleReport {
  dirs: BundleDir[];
  truncated: boolean;
}

export interface Route {
  framework: string;
  method: string;
  path: string;
  file: string;
  line: number;
}
export interface RouteMap {
  routes: Route[];
  frameworks: string[];
  filesScanned: number;
  truncated: boolean;
  skipped: string[];
}

export interface EnvFile {
  path: string;
  example: boolean;
  unprotected: boolean;
  tracked: boolean;
  keys: number;
}
export interface EnvDir {
  dir: string;
  files: EnvFile[];
  missing: { key: string; example: string }[];
  undocumented: string[];
  noExample: boolean;
  noEnv: boolean;
}
export interface EnvReport {
  dirs: EnvDir[];
  skipped: string[];
}

export interface LiveServer {
  id: string;
  repoId: string;
  runner: string;
  ports: number[];
}
export interface TryRequest {
  port: number;
  method: string;
  path: string;
  headers: [string, string][];
  body?: string;
}
export interface TryResponse {
  status: number;
  reason: string;
  headers: [string, string][];
  body: string;
  bodyTruncated: boolean;
  binary: boolean;
  bytes: number;
  millis: number;
  host: string;
  redirect: string | null;
}

export interface OutdatedPkg {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  jump: "major" | "minor" | "patch" | "unknown";
  dev: boolean;
}
export interface AuditItem {
  name: string;
  severity: "info" | "low" | "moderate" | "high" | "critical";
  direct: boolean;
  fix: "none" | "safe" | "major";
  title: string;
}
export interface AuditReport {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
  items: AuditItem[];
}
export interface DepsReport {
  outdated: OutdatedPkg[] | null;
  audit: AuditReport | null;
  notes: string[];
}

export interface RuleQuery {
  tag: string;
  id: string;
  classes: string[];
}
export interface RuleMatch {
  file: string;
  line: number;
  selector: string;
  score: number;
  why: ("class" | "id" | "tag" | "module")[];
}

export type Section = "tokens" | "styles" | "react" | "bundle" | "routes" | "env" | "deps";
