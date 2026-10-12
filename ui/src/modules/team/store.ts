import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TeamInvite, TeamPresence, TeamView } from "../../ipc/team";

const EMPTY: TeamView = { state: "none", relay: "", epoch: 0, connected: false, members: [], auditEntries: 0 };

const [view, setView] = createSignal<TeamView>(EMPTY);
const [loaded, setLoaded] = createSignal(false);
const [loadError, setLoadError] = createSignal<string | undefined>(undefined);

export { view, loaded, loadError };

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** The relay answered but has no Team routes: it was deployed before teams existed. */
export const isRelayOld = (e: unknown): boolean => codeOf(e) === "relayOld";

/** Text for a failure: the relay's raw transport codes (`create:500`, `timeout`) become sentences, anything else keeps its message. */
export function messageOf(e: unknown): string {
  const raw = (e as { message?: string } | null)?.message ?? String(e);
  if (isRelayOld(e)) return t("team.err.relayOld");
  if (codeOf(e) !== "relay") return raw;
  const http = /^(?:create|join):(\d{3})$/.exec(raw);
  if (http) return t("team.err.relayHttp", { status: http[1] });
  if (raw === "timeout" || raw === "offline") return t("team.err.timeout");
  return t("team.err.unreachable");
}

let watching: (() => void) | undefined;

/** The backend pushes the whole view after every change and a small event when somebody comes or goes. Once per page. */
function watch(): void {
  if (watching) return;
  const offChanged = ipc.team.onChanged((v) => setView(v));
  const offPresence = ipc.team.onPresence((p: TeamPresence) => setView((v) => ({ ...v, members: v.members.map((m) => (m.id === p.id ? { ...m, online: p.online, state: p.state } : m)) })));
  watching = () => (offChanged(), offPresence());
}

/** Reads the team (cheap: no network). Safe to call again. */
export async function loadTeam(): Promise<void> {
  watch();
  try {
    setView(await ipc.team.status());
    setLoadError(undefined);
  } catch (e) {
    setLoadError(messageOf(e));
  } finally {
    setLoaded(true);
  }
}

/** Runs a command that answers with the new view. */
async function act(f: () => Promise<TeamView>): Promise<void> {
  setView(await f());
}

export const createTeam = (name: string) => act(() => ipc.team.create(name));
export const joinTeam = (code: string, name: string) => act(() => ipc.team.join(code, name));
export const confirmJoin = (accept: boolean) => act(() => ipc.team.joinConfirm(accept));
export const decideJoin = (accept: boolean) => act(() => ipc.team.joinDecide(accept));
export const revokeMember = (id: string) => act(() => ipc.team.revoke(id));
export const leaveTeam = () => act(() => ipc.team.leave());
export const forgetTeam = () => act(() => ipc.team.forget());

export async function openInvite(): Promise<TeamInvite> {
  const invite = await ipc.team.invite();
  setView((v) => ({ ...v, invite }));
  return invite;
}

/** Tests: forget everything and the watchers. */
export function resetTeam(): void {
  watching?.();
  watching = undefined;
  setView(EMPTY);
  setLoaded(false);
  setLoadError(undefined);
}
