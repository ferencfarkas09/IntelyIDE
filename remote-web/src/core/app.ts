// App state (Solid store) and the actions the screens call. One module-level instance: the PWA is a single page.
import { createRoot } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { Session, type Conn } from "./session";
import { wsBase } from "./relay";
import { load, loadDevice, remove, save, saveDevice, wipeAll, type DeviceRecord } from "./storage";
import { apply, emptyTranscript, fold, markQuestionAnswered, type Transcript } from "./transcript";
import type { AgentEvent, Capability, ReqCard, RunCard, ServerMsg } from "./wire";
import { now } from "../ui/clock";
import { BLOCKING, bundleInfo } from "./bundle";
import { resubscribeIfKeyChanged } from "./push";
import { pinFromMac } from "../sw/page";
import type { StepUpProof } from "@ui/bindings/remote";

export type Phase = "boot" | "onboarding" | "main" | "revoked";

export interface Resolution {
  /** When the phone learned about it (the card stays on Home, locked, for a few seconds). */
  at: number;
  outcome: string;
  by: string;
  origin: "desktop" | "remote";
  mine: boolean;
}

export interface Card extends ReqCard {
  resolution?: Resolution;
  /** An answer is on its way. */
  sending?: boolean;
  error?: string;
}

export interface QueuedPrompt {
  id: string;
  agentId: string;
  text: string;
  mode: "queue" | "interrupt";
  at: number;
}

export interface AppState {
  phase: Phase;
  conn: Conn;
  device: DeviceRecord | null;
  macName: string;
  capability: Capability;
  reauthRequired: boolean;
  runs: RunCard[];
  cards: Record<string, Card>;
  transcripts: Record<string, Transcript>;
  /** Data on screen is the cached snapshot from this time, not live. */
  staleSince: number | null;
  macLastSeen: number | null;
  revokedReason: string;
  /** Prompts typed while offline: shown as "queued, not sent" and never sent automatically after a long gap. */
  queue: QueuedPrompt[];
  banner: string | null;
  /** The running build failed the signature, key or rollback check: the Noise channel is not opened (Settings shows why). */
  integrity: "ok" | "badSignature" | "keyChanged" | "rollback";
  diffs: Record<string, { path: string; old: string | null; new: string; truncated: boolean }>;
}

const SNAP_KEY = "snapshot.v1";
export const QUEUE_EXPIRY_MS = 5 * 60_000;

function initial(): AppState {
  return { phase: "boot", conn: "stopped", device: null, macName: "Mac", capability: "view", reauthRequired: false, runs: [], cards: {}, transcripts: {}, staleSince: null, macLastSeen: null, revokedReason: "", queue: [], banner: null, integrity: "ok", diffs: {} };
}

const { state, setState, session } = createRoot(() => {
  const [state, setState] = createStore<AppState>(initial());
  return { state, setState, session: { current: null as Session | null } };
});

export { state };

/** Test hook: a clean slate. */
export function resetApp(): void {
  session.current?.stop();
  session.current = null;
  setState(reconcile(initial()));
}

// ------------------------------------------------------------------ boot and session

export function boot(opts: { base?: string; wsCtor?: ConstructorParameters<typeof Session>[0]["wsCtor"] } = {}): void {
  const device = loadDevice();
  if (!device) {
    setState({ phase: "onboarding" });
    return;
  }
  const snap = load<{ runs: RunCard[]; needsYou: ReqCard[]; at: number }>(SNAP_KEY);
  if (snap) {
    setState({ runs: snap.runs, cards: Object.fromEntries(snap.needsYou.map((c) => [c.reqId, c as Card])), staleSince: snap.at });
  }
  setState({ phase: "main", device, macName: device.macName, capability: device.capability, queue: load<QueuedPrompt[]>("queue.v1") ?? [] });
  // The build is checked BEFORE the first handshake: a build that fails its signature, key or rollback check never talks to the Mac.
  // `missing` (offline start without a reachable manifest) does not block: the shell cache was verified when it was installed.
  void bundleInfo().then((b) => {
    if (BLOCKING.has(b.state)) setState({ integrity: b.state as AppState["integrity"], conn: "stopped" });
    else startSession(device, opts);
  });
}

function startSession(device: DeviceRecord, opts: { base?: string; wsCtor?: ConstructorParameters<typeof Session>[0]["wsCtor"] } = {}): void {
  session.current?.stop();
  const s = new Session({
    device,
    base: opts.base ?? wsBase(),
    wsCtor: opts.wsCtor,
    handlers: {
      onConn(conn, detail) {
        setState({ conn });
        if (conn === "macOffline") setState({ macLastSeen: detail?.lastSeen ?? state.macLastSeen, staleSince: state.staleSince ?? Date.now() });
        if (conn === "live") {
          setState({ macLastSeen: null });
          void resubscribeIfKeyChanged((c) => sendRelayControl(c));
        }
      },
      onMsg: handle,
      lastSeq: () => Object.fromEntries(Object.entries(state.transcripts).map(([id, t]) => [id, t.lastSeq])),
      onRevoked: (reason) => revokedLocally(reason),
    },
  });
  session.current = s;
  s.start();
}

/** After pairing: store the device and go live. */
export function paired(device: DeviceRecord, opts?: Parameters<typeof boot>[0]): void {
  saveDevice(device);
  boot(opts);
}

export function revokedLocally(reason: string): void {
  session.current?.stop();
  session.current = null;
  wipeAll();
  setState({ ...initial(), phase: "revoked", revokedReason: reason });
}

export async function signOut(): Promise<void> {
  try {
    await session.current?.request((opId) => ({ t: "signOut", opId }));
  } catch {
    /* offline: the Mac will drop the device on its own when it is told on the desktop */
  }
  revokedLocally("You signed out of this device.");
  setState({ phase: "onboarding", revokedReason: "" });
}

export function startOver(): void {
  wipeAll();
  setState({ ...initial(), phase: "onboarding" });
}

export const sendRelayControl = (c: { t: string; [k: string]: unknown }): boolean => !!session.current?.sendControl(c);

export const refresh = (): void => void session.current?.send({ t: "sync", lastSeq: Object.fromEntries(Object.entries(state.transcripts).map(([id, t]) => [id, t.lastSeq])) });

// ------------------------------------------------------------------ incoming

function persistSnapshot(): void {
  save(SNAP_KEY, { runs: JSON.parse(JSON.stringify(state.runs)), needsYou: Object.values(state.cards).filter((c) => !c.resolution).map((c) => stripCard(c)), at: Date.now() });
}

const stripCard = (c: Card): ReqCard => {
  const { resolution: _r, sending: _s, error: _e, ...rest } = c;
  return JSON.parse(JSON.stringify(rest));
};

function touchRun(agentId: string, patch: Partial<RunCard>): void {
  setState("runs", (r) => r.agentId === agentId, patch);
}

function onEvent(agentId: string, ev: AgentEvent): void {
  setState(
    produce((s) => {
      const t = (s.transcripts[agentId] ??= emptyTranscript());
      apply(t, ev);
    }),
  );
  const patch: Partial<RunCard> = { lastSeq: ev.seq };
  switch (ev.kind) {
    case "text.done":
      patch.lastText = ev.text.slice(0, 200);
      patch.status = "running";
      break;
    case "user.message":
    case "tool.start":
      patch.status = "running";
      break;
    case "error":
      patch.status = "error";
      break;
    case "turn.end":
      patch.status = "done";
      break;
    case "permission.request":
    case "question.request":
      patch.status = "needsYou";
      break;
    default:
      break;
  }
  if (state.runs.some((r) => r.agentId === agentId)) touchRun(agentId, patch);
}

function handle(m: ServerMsg): void {
  switch (m.t) {
    case "hello":
      setState({ capability: m.capability, macName: m.macName, reauthRequired: m.reauthRequired, staleSince: null });
      if (state.device && state.device.macName !== m.macName) saveDevice({ ...state.device, macName: m.macName });
      break;
    case "snapshot":
      setState("runs", reconcile(m.runs, { key: "agentId" }));
      setState(
        "cards",
        produce((cards) => {
          for (const id of Object.keys(cards)) if (!cards[id]!.resolution) delete cards[id];
          for (const c of m.needsYou) cards[c.reqId] = c as Card;
        }),
      );
      setState({ staleSince: null });
      persistSnapshot();
      flushQueue();
      break;
    case "event":
      onEvent(m.agentId, m.ev);
      break;
    case "runSnapshot":
      setState(
        produce((s) => {
          s.transcripts[m.run.agentId] = fold(m.events);
          const i = s.runs.findIndex((r) => r.agentId === m.run.agentId);
          if (i >= 0) s.runs[i] = m.run;
          else s.runs.push(m.run);
        }),
      );
      persistSnapshot();
      break;
    case "reqNew":
      setState("cards", m.req.reqId, m.req as Card);
      persistSnapshot();
      break;
    case "reqResolved": {
      const mine = state.cards[m.reqId]?.sending === true || state.cards[m.reqId]?.resolution?.mine === true;
      const origin = m.origin.kind;
      setState("cards", m.reqId, (c) => (c ? { ...c, sending: false, resolution: { at: Date.now(), outcome: m.outcome, by: m.by, origin: origin as "desktop" | "remote", mine } } : c));
      setState(
        produce((s) => {
          const t = s.transcripts[m.agentId];
          if (t) for (const r of t.rows) if (r.kind === "question" && r.reqId === m.reqId) r.state = "answered";
        }),
      );
      persistSnapshot();
      break;
    }
    case "welcome":
      void pinFromMac(m.bundlePub);
      break;
    case "capabilityChanged":
      setState({ capability: m.capability, reauthRequired: m.reauthRequired });
      break;
    case "diff":
      setState("diffs", `${m.agentId}:${m.toolId}`, { path: m.path, old: m.old, new: m.new, truncated: m.truncated });
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ actions

const ready = (): Session => {
  const s = session.current;
  if (!s || !s.isLive) throw new Error("Not connected to the Mac.");
  return s;
};

/** This device may reply (level and passkey window), whether or not the Mac is reachable right now. */
export const canReply = (): boolean => state.capability === "reply" && !state.reauthRequired;
/** Answers need the Mac: a card is never actionable from a stale snapshot. */
export const canAnswer = (): boolean => canReply() && state.conn === "live";

export async function answerPermission(reqId: string, decision: "allowOnce" | "deny", extra: { stepUp?: StepUpProof } = {}): Promise<void> {
  const card = state.cards[reqId];
  if (!card) return;
  setState("cards", reqId, { sending: true, error: undefined });
  try {
    const ack = await ready().request((opId) => ({ t: "answer", opId, reqId, agentId: card.agentId, decision, intentHash: card.intentHash, stepUp: extra.stepUp ?? null }));
    if (!ack.ok) setState("cards", reqId, { sending: false, error: ack.message ?? "The Mac refused this answer." });
    // success: the Mac follows with reqResolved, which locks the card
  } catch (e) {
    setState("cards", reqId, { sending: false, error: (e as Error).message });
  }
}

export async function answerQuestion(reqId: string, optionIds: string[], text: string | null): Promise<void> {
  const card = state.cards[reqId];
  if (!card) return;
  setState("cards", reqId, { sending: true, error: undefined });
  try {
    const ack = await ready().request((opId) => ({ t: "answer", opId, reqId, agentId: card.agentId, question: { optionIds, text }, intentHash: card.intentHash }));
    if (!ack.ok) setState("cards", reqId, { sending: false, error: ack.message ?? "The Mac refused this answer." });
    else {
      setState("cards", reqId, { sending: false, resolution: { at: Date.now(), outcome: "allow", by: "user", origin: "remote", mine: true } });
      setState(produce((s) => void (s.transcripts[card.agentId] && markQuestionAnswered(s.transcripts[card.agentId]!, reqId))));
    }
  } catch (e) {
    setState("cards", reqId, { sending: false, error: (e as Error).message });
  }
}

export async function sendPrompt(agentId: string, text: string, mode: "queue" | "interrupt"): Promise<{ ok: boolean; message?: string; queued?: boolean }> {
  const s = session.current;
  if (!s || !s.isLive) {
    const q: QueuedPrompt = { id: String(Date.now()), agentId, text, mode, at: Date.now() };
    setState("queue", (x) => [...x, q]);
    save("queue.v1", state.queue);
    return { ok: true, queued: true };
  }
  try {
    const ack = await s.request((opId) => ({ t: "prompt", opId, agentId, text, mode }));
    return ack.ok ? { ok: true } : { ok: false, message: ack.message ?? "The Mac refused this prompt." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Follow-ups typed offline are never sent by themselves: old ones are dropped with a notice, recent ones wait for a tap. */
export function flushQueue(): void {
  const now = Date.now();
  const fresh = state.queue.filter((q) => now - q.at <= QUEUE_EXPIRY_MS);
  if (fresh.length === state.queue.length) return;
  setState({ queue: fresh, banner: "Some follow-ups were typed a while ago and were not sent. Send them again if you still want them." });
  save("queue.v1", state.queue);
}

export async function sendQueued(id: string): Promise<void> {
  const q = state.queue.find((x) => x.id === id);
  if (!q) return;
  const r = await sendPrompt(q.agentId, q.text, q.mode);
  if (r.ok && !r.queued) {
    setState("queue", (x) => x.filter((y) => y.id !== id));
    save("queue.v1", state.queue);
  }
}

export function dropQueued(id: string): void {
  setState("queue", (x) => x.filter((y) => y.id !== id));
  save("queue.v1", state.queue);
}

export async function stopRun(agentId: string): Promise<string | null> {
  try {
    const ack = await ready().request((opId) => ({ t: "stop", opId, agentId }));
    return ack.ok ? null : (ack.message ?? "The Mac refused.");
  } catch (e) {
    return (e as Error).message;
  }
}

export async function stopAll(): Promise<string | null> {
  try {
    const ack = await ready().request((opId) => ({ t: "stopAll", opId }));
    return ack.ok ? null : (ack.message ?? "The Mac refused.");
  } catch (e) {
    return (e as Error).message;
  }
}

export const requestDiff = (agentId: string, toolId: string): void => void session.current?.request((opId) => ({ t: "diffGet", opId, agentId, toolId })).catch(() => {});

// ------------------------------------------------------------------ drafts

export const loadDraft = (agentId: string): string => load<Record<string, string>>("drafts.v1")?.[agentId] ?? "";
export function saveDraft(agentId: string, text: string): void {
  const all = load<Record<string, string>>("drafts.v1") ?? {};
  if (text) all[agentId] = text;
  else delete all[agentId];
  Object.keys(all).length ? save("drafts.v1", all) : remove("drafts.v1");
}

// ------------------------------------------------------------------ derived

export const LOCK_SHOW_MS = 4000;
const byUrgency = (a: Card, b: Card) => a.expiresAt - b.expiresAt || a.reqId.localeCompare(b.reqId);
/** Still waiting for an answer. */
export const needsYouCards = (): Card[] => Object.values(state.cards).filter((c) => !c.resolution).sort(byUrgency);
/** Home shows answered cards, locked, for a few seconds so a tap visibly lands (and "answered on the Mac" is seen). */
export const homeCards = (): Card[] => Object.values(state.cards).filter((c) => !c.resolution || now() - c.resolution.at < LOCK_SHOW_MS).sort(byUrgency);
export const cardsOf = (agentId: string): Card[] => Object.values(state.cards).filter((c) => c.agentId === agentId).sort((a, b) => a.expiresAt - b.expiresAt);
export const runOf = (agentId: string): RunCard | undefined => state.runs.find((r) => r.agentId === agentId);

export function groups(): { needsYou: RunCard[]; running: RunCard[]; ready: RunCard[]; failed: RunCard[]; earlier: RunCard[] } {
  const open = new Set(needsYouCards().map((c) => c.agentId));
  const g = { needsYou: [] as RunCard[], running: [] as RunCard[], ready: [] as RunCard[], failed: [] as RunCard[], earlier: [] as RunCard[] };
  const recent = Date.now() - 24 * 3_600_000;
  for (const r of [...state.runs].sort((a, b) => b.startedAt - a.startedAt)) {
    if (open.has(r.agentId) || r.status === "needsYou") g.needsYou.push(r);
    else if (r.status === "running") g.running.push(r);
    else if (r.status === "error") (r.startedAt > recent ? g.failed : g.earlier).push(r);
    else (r.startedAt > recent ? g.ready : g.earlier).push(r);
  }
  return g;
}
