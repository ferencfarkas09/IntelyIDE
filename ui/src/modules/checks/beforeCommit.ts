import type { CommitGuardContext } from "../../platform/commitSlots";
import { repoName } from "../../store/actions";
import { beforeCommit } from "./toggle";

/** "Run before commit": runs the quick checks, warns about failures and always lets the commit go on. */
export async function beforeCommitGuard(ctx: CommitGuardContext): Promise<boolean> {
  if (!beforeCommit()) return true;
  try {
    await (await import("./store")).runBeforeCommit(ctx.repos, repoName);
  } catch (e) {
    console.error("Run before commit failed", e);
  }
  return true;
}
