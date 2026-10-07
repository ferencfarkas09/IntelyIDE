// Mirrors crates/contract (serde camelCase). Keep in step with `analyze.rs` and `spec.rs`.
export type Severity = "error" | "warn" | "info";
export type Confidence = "high" | "medium" | "low";
export type Kind = "missing" | "renamed" | "method" | "requiredParam" | "responseField" | "deprecated" | "tagMismatch";

export interface Source {
  file: string;
  line: number;
}

export interface Site {
  repoId: string;
  file: string;
  line: number;
  col: number;
  snippet: string;
}

export interface Suggestion {
  id: string;
  method: string;
  path: string;
  operationId: string | null;
  similarity: number;
  source: Source;
}

export interface Finding {
  id: string;
  kind: Kind;
  severity: Severity;
  confidence: Confidence;
  heuristic: boolean;
  repoId: string;
  site: Site;
  target: string;
  suggestion: Suggestion | null;
  names: string[];
  allowed: string[];
  swagger: Source | null;
}

export interface Counts {
  files: number;
  calls: number;
  matched: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface ClientReport {
  repoId: string;
  fingerprint: string;
  cached: boolean;
  counts: Counts;
  findings: Finding[];
  usage: Record<string, Site[]>;
  /** Per source file: [calls, errors, warnings]. */
  files: Record<string, [number, number, number]>;
}

export interface Unused {
  id: string;
  method: string;
  path: string;
  operationId: string | null;
  tags: string[];
  deprecated: boolean;
  source: Source;
}

export interface Param {
  name: string;
  in: string;
  required: boolean;
  type: string;
}

export interface Shape {
  array: boolean;
  props: string[];
  required: string[];
  open: boolean;
}

export interface Endpoint {
  id: string;
  method: string;
  path: string;
  operationId: string | null;
  tags: string[];
  summary: string;
  deprecated: boolean;
  params: Param[];
  bodyRequired: boolean;
  hasBody: boolean;
  request: Shape | null;
  response: Shape | null;
  source: Source;
}

export interface SpecInfo {
  repoId: string;
  kind: string;
  title: string;
  version: string;
  host: string;
  files: string[];
  endpoints: number;
  definitions: number;
}

export interface Report {
  fingerprint: string;
  spec: SpecInfo;
  clients: ClientReport[];
  unused: Unused[];
  endpoints: Endpoint[];
  definitions: string[];
}

export interface Prop {
  name: string;
  node: SchemaNode;
}

export interface SchemaNode {
  type: string;
  format: string | null;
  description: string | null;
  required: boolean;
  enum: unknown[];
  example: unknown | null;
  default: unknown | null;
  refName: string | null;
  props: Prop[];
  items: SchemaNode | null;
  additional: SchemaNode | null;
  circular: boolean;
  truncated: boolean;
}

export interface ParamDetail {
  name: string;
  in: string;
  required: boolean;
  description: string;
  schema: SchemaNode;
}

export interface ResponseDetail {
  status: string;
  description: string;
  schema: SchemaNode | null;
}

export interface Detail {
  endpoint: Endpoint;
  description: string;
  params: ParamDetail[];
  request: SchemaNode | null;
  consumes: string[];
  responses: ResponseDetail[];
  secured: boolean;
}
