import { t, type MessageKey } from "../../i18n";
import type { PickWarning, Picked } from "../../ipc/picker";

const WARNING_KEYS: Partial<Record<PickWarning, MessageKey>> = {
  cloudFolder: "picker.warn.cloud",
  network: "picker.warn.network",
  externalVolume: "picker.warn.network",
  insideIgnored: "picker.warn.ignored",
  foreignOwner: "picker.warn.owner",
  homeIsRepo: "picker.warn.homeRepo",
  gitSymlink: "picker.warn.gitSymlink",
  limitedSupport: "picker.warn.limitedSupport",
};

/** One line per warning of a picked folder (the `workspacePicker` strings; warnings never block). */
export function warningLines(p: Pick<Picked, "warnings" | "gitfileTarget">): string[] {
  const seen = new Set<MessageKey | "redirect">();
  const out: string[] = [];
  for (const w of p.warnings) {
    if (w === "gitfileRedirect") {
      if (!seen.has("redirect")) out.push(t("picker.warn.redirect", { target: p.gitfileTarget ?? "" }));
      seen.add("redirect");
      continue;
    }
    const key = WARNING_KEYS[w];
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(t(key));
    }
  }
  return out;
}

/** What kind of folder it is, in words. */
export function kindLine(p: Pick<Picked, "kind" | "main" | "root">): string {
  switch (p.kind) {
    case "repo":
      return t("picker.kind.repo");
    case "worktree":
      return t("picker.kind.worktree", { main: p.main ?? "" });
    case "submodule":
      return t("picker.kind.submodule");
    case "subfolder":
      return t("picker.kind.subfolder", { root: p.root?.path ?? "" });
    case "bare":
      return t("picker.kind.bare");
    case "gitDir":
      return t("picker.kind.gitDir");
    default:
      return t("picker.kind.notGit");
  }
}

/** Key names that make a repository's config able to run programs, for the trust card. */
export const riskKeys = (p: Pick<Picked, "configRisks">): string => p.configRisks.join(", ");

/** `true` for the kinds a workspace can hold. */
export const isRepoKind = (p: Pick<Picked, "kind">): boolean => p.kind === "repo" || p.kind === "worktree" || p.kind === "submodule";
