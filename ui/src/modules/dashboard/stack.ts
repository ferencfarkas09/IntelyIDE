// "Stack tips": what a repository is built with (package.json dependencies, ios/ and android/ folders) and three starter prompts
// that fit it. Repositories are untrusted input: only the names of dependencies are looked at, never a script or a value, a file
// the guard hides or one that is too large is skipped, and nothing read here is ever run.
import type { MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import { requestNewRun } from "../../platform/newRun";

export type StackTag = "expo" | "react-native" | "next" | "react" | "express" | "node" | "sass" | "ios" | "android";

/** Display order and tip priority: the most specific first (an Expo app is also React Native and React). */
export const STACK_ORDER: readonly StackTag[] = ["expo", "react-native", "next", "react", "express", "node", "sass", "ios", "android"];

export const STACK_LABEL: Record<StackTag, string> = { expo: "Expo", "react-native": "React Native", next: "Next.js", react: "React", express: "Express", node: "Node.js", sass: "Sass", ios: "iOS", android: "Android" };

const DEPS: [string, StackTag][] = [
  ["expo", "expo"],
  ["react-native", "react-native"],
  ["next", "next"],
  ["react", "react"],
  ["express", "express"],
  ["sass", "sass"],
  ["node-sass", "sass"],
  ["sass-embedded", "sass"],
];

/** The tags of one repository from its parsed package.json (anything) and the names in its root folder. */
export function detectStack(packageJson: unknown, rootNames: readonly string[]): StackTag[] {
  const tags = new Set<StackTag>();
  const pkg = packageJson && typeof packageJson === "object" && !Array.isArray(packageJson) ? (packageJson as Record<string, unknown>) : undefined;
  if (pkg) {
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[field];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) for (const n of Object.keys(deps)) names.add(n);
    }
    for (const [dep, tag] of DEPS) if (names.has(dep)) tags.add(tag);
    if (!tags.has("react") && !tags.has("react-native") && !tags.has("next") && !tags.has("expo")) tags.add("node");
    if (tags.has("express")) tags.delete("node");
  }
  const has = (n: string) => rootNames.includes(n);
  if (has("ios")) tags.add("ios");
  if (has("android")) tags.add("android");
  if (rootNames.some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"))) tags.add("ios");
  if (has("build.gradle") || has("build.gradle.kts") || has("settings.gradle") || has("settings.gradle.kts")) tags.add("android");
  return STACK_ORDER.filter((t) => tags.has(t));
}

export interface StackTip {
  id: string;
  title: MessageKey;
  prompt: MessageKey;
}

const tip = (id: string): StackTip => ({ id, title: `dash.tip.${id}.title` as MessageKey, prompt: `dash.tip.${id}.prompt` as MessageKey });

const TIPS: Record<StackTag | "any", StackTip[]> = {
  expo: [tip("expoOffline"), tip("expoIcons")],
  "react-native": [tip("rnSafeArea"), tip("rnDarkMode")],
  next: [tip("nextStates"), tip("nextSeo")],
  react: [tip("reactStates"), tip("reactA11y")],
  express: [tip("expressValidate"), tip("expressHealth")],
  node: [tip("nodeTests")],
  sass: [tip("sassTokens")],
  ios: [tip("iosPrivacy")],
  android: [tip("androidWarnings")],
  any: [tip("explain"), tip("bugs"), tip("readme")],
};

/** Three tips: the first of each detected tag in priority order, then the second ones, then general ones. */
export function pickTips(tags: readonly StackTag[], n = 3): StackTip[] {
  const ordered = STACK_ORDER.filter((t) => tags.includes(t));
  const out: StackTip[] = [];
  const add = (x: StackTip | undefined) => x && !out.some((o) => o.id === x.id) && out.length < n && out.push(x);
  for (let round = 0; round < 2; round++) for (const t of ordered) add(TIPS[t][round]);
  for (const x of TIPS.any) add(x);
  return out;
}

export interface RepoStack {
  repoId: string;
  tags: StackTag[];
}

/** Larger than any real package.json: anything bigger is not looked at. */
const MAX_PACKAGE_BYTES = 512 * 1024;

/** Reads the root folder and package.json of one repository through the file IPC (the same guard as the editor). Never throws. */
export async function readRepoStack(repoId: string): Promise<RepoStack> {
  try {
    const entries = await ipc.files.listDir(repoId, "");
    const names = entries.map((e) => e.name);
    let pkg: unknown;
    const pj = entries.find((e) => e.name === "package.json" && e.kind === "file" && !e.neverRead);
    if (pj && (pj.size ?? 0) <= MAX_PACKAGE_BYTES) {
      const file = await ipc.files.readFile(repoId, "package.json");
      if (file.text && !file.binary && !file.tooLarge) {
        try {
          pkg = JSON.parse(file.text);
        } catch {
          pkg = undefined;
        }
      }
    }
    return { repoId, tags: detectStack(pkg, names) };
  } catch {
    return { repoId, tags: [] };
  }
}

/**
 * The thin adapter between a starter prompt and the New run dialog (the prompt library may later take its place): it only fills
 * the dialog; nothing runs until the person presses Start run.
 */
export const startStarter = (prompt: string, repoIds?: string[]): Promise<boolean> => requestNewRun({ prompt, ...(repoIds?.length ? { repoIds } : {}) });
