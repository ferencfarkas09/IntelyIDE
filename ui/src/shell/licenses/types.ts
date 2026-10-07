/** Shape of the generated bundle in `data/` ((design notes: licensing-spec) 8.2). */
export type ComponentKind = "cargo" | "npm" | "font" | "manual";
export type ShippedIn = "app" | "sidecar" | "remote-web" | "relay";

export interface Component {
  id: string;
  kind: ComponentKind;
  name: string;
  version: string;
  expression: string;
  chosen: string[];
  copyright: string[];
  textIds: string[];
  shippedIn: ShippedIn[];
  optional?: true;
  distributed: boolean;
  homepage?: string;
  sourceUrl?: string;
  generic?: true;
  note?: string;
  verdict: "ok" | "attention";
}

export interface LicenseGroup {
  id: string;
  count: number;
}

export interface LicenseIndex {
  schema: 1;
  generator: { tool: string; cargoLockSha256: string; pnpmLockSha256: Record<string, string>; platforms: string[]; features: "all" };
  project: { name: string; license: "GPL-3.0-or-later"; copyright: string; textIds: string[]; sourceUrl?: string };
  groups: LicenseGroup[];
  components: Component[];
}

export interface LicenseText {
  spdx?: string;
  title: string;
  kind: "license" | "notice";
  body: string;
}

export interface LicenseTexts {
  schema: 1;
  texts: Record<string, LicenseText>;
}

export type KindFilter = "all" | "rust" | "npm" | "fonts";
