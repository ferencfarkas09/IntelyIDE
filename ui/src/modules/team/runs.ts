import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { TeamRun } from "../../ipc/team";
import { emptyView, reduceEvents, type AgentView } from "../../store/agent-reducer";
import { messageOf } from "./store";

// What teammates share, read-only. The backend holds the data in memory; this store keeps the list and the one transcript on screen.
const [runs, setRuns] = createSignal<TeamRun[]>([]);
const [selected, setSelected] = createSignal<{ memberId: string; runId: string } | undefined>(undefined);
const [transcript, setTranscript] = createSignal<AgentView | undefined>(undefined);
const [runsError, setRunsError] = createSignal<string | undefined>(undefined);

export { runs, selected, transcript, runsError };

let watching: (() => void) | undefined;
let loadToken = 0;

function watch(): void {
  if (watching) return;
  const offRuns = ipc.team.onRuns((list) => {
    setRuns(list);
    const s = selected();
    // the run was withdrawn: the transcript goes with it
    if (s && !list.some((r) => r.memberId === s.memberId && r.runId === s.runId)) selectRun(undefined);
  });
  const offEvents = ipc.team.onRunEvents((e) => {
    const s = selected();
    if (!s || s.memberId !== e.memberId || s.runId !== e.runId) return;
    // a new session of the run starts its numbers over: read the run again instead of letting the old counter swallow it
    if ((transcript()?.lastSeq ?? 0) > 0 && e.events.some((x) => x.kind === "session.started" && x.seq <= (transcript()?.lastSeq ?? 0))) return selectRun(s);
    setTranscript((v) => reduceEvents(v ?? emptyView(e.runId), e.events));
  });
  watching = () => (offRuns(), offEvents());
}

/** Reads the list (cheap, in memory on the backend) and follows changes. Safe to call again. */
export async function loadRuns(): Promise<void> {
  watch();
  try {
    setRuns(await ipc.team.runs());
    setRunsError(undefined);
  } catch (e) {
    setRunsError(messageOf(e));
  }
}

/** Shows one shared run: the events the backend holds now, then the live ones. */
export function selectRun(pick: { memberId: string; runId: string } | undefined): void {
  const token = ++loadToken;
  setSelected(pick);
  setTranscript(pick ? emptyView(pick.runId) : undefined);
  if (!pick) return;
  void ipc.team
    .runEvents(pick.memberId, pick.runId)
    .then((events) => {
      // events that arrived while loading are in the backend's list too; the reducer ignores what it has seen
      if (token === loadToken) setTranscript((v) => reduceEvents(v ?? emptyView(pick.runId), events));
    })
    .catch((e) => token === loadToken && setRunsError(messageOf(e)));
}

/** Tests: forget everything and the watchers. */
export function resetRuns(): void {
  watching?.();
  watching = undefined;
  loadToken++;
  setRuns([]);
  setSelected(undefined);
  setTranscript(undefined);
  setRunsError(undefined);
}
