import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { openSettings } from "../../platform/settings";
import { toast } from "../../ui-kit";
import { loaded, loadTeam, view } from "./store";

/** The text of an invite link that waits for the join form (Settings > Team); the form takes it once. */
const [pendingInvite, setPendingInvite] = createSignal<string | undefined>(undefined);
export { pendingInvite };

/** Hands the waiting link text over (the join form calls this when it has put it in its field). */
export function consumeInvite(): string | undefined {
  const text = pendingInvite();
  setPendingInvite(undefined);
  return text;
}

/**
 * A link reached the app: Settings > Team opens with the code in the join form. The form still shows what the code points to and asks
 * for the person's trust and name; nothing is joined here. An install that is in a team (or joining one) cannot take another invite and
 * is told so.
 */
export async function receiveInviteLink(text: string): Promise<void> {
  if (!loaded()) await loadTeam().catch(() => undefined);
  if (view().state === "none") setPendingInvite(text);
  else toast.info(t("team.link.inTeam"), t("team.link.inTeamDesc"));
  openSettings("team");
}

let started = false;

/** Once per page: a link that started the app waits in the backend, and a link clicked later announces itself. */
export function startInviteLinks(): void {
  if (started) return;
  started = true;
  const pull = () => void ipc.team.takeInviteLink().then((text) => (text ? receiveInviteLink(text) : undefined), () => undefined);
  ipc.team.onInviteLink(pull);
  pull();
  // the subscription completes a moment later: a link that arrived in between is asked for again once
  setTimeout(pull, 1500);
}

/** For tests: forgets the waiting link and lets `startInviteLinks` run again. */
export function resetInviteLinks(): void {
  started = false;
  setPendingInvite(undefined);
}
