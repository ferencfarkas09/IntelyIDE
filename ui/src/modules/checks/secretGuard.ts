// The secret-in-diff confirmation of the commit flow: scans what the ticked files would add, and when a secret-looking
// value shows up asks (blocking) before the commit starts. The engine only ever returns redacted previews.
import { createSignal } from "solid-js";
import type { CommitGuardContext } from "../../platform/commitSlots";
import { t } from "../../i18n";
import { toast } from "../../ui-kit";
import { checksApi } from "./api";
import { errorText, totalFindings, type FindingGroup } from "./logic";
import { secretGuardEnabled } from "./toggle";

interface Ask {
  groups: FindingGroup[];
  resolve: (go: boolean) => void;
}

const [ask, setAsk] = createSignal<Ask | null>(null);
export const secretAsk = ask;

export function answerSecretAsk(go: boolean): void {
  const a = ask();
  setAsk(null);
  a?.resolve(go);
}

/** Resolves false when the user decides not to commit. A scan that fails warns and lets the commit go on. */
export async function secretGuard(ctx: CommitGuardContext): Promise<boolean> {
  if (!secretGuardEnabled()) return true;
  const groups: FindingGroup[] = [];
  try {
    for (const r of ctx.repos) {
      const scan = await checksApi().scan(r.repoId, r.paths);
      if (scan.findings.length) groups.push({ repoId: r.repoId, findings: scan.findings });
    }
  } catch (e) {
    toast.warn(t("checks.toast.scanSkipped"), errorText(e));
    return true;
  }
  if (!totalFindings(groups)) return true;
  return new Promise<boolean>((resolve) => setAsk({ groups, resolve }));
}
