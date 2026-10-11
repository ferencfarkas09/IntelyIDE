import type { AgentEvent } from "../../store/agent-types";
import { createMockTeamMemory } from "../teamMemory";
import type { TeamInvite, TeamIpc, TeamMember, TeamNoteIn, TeamNoteStatus, TeamPresence, TeamProject, TeamRun, TeamRunEvents, TeamSentNote, TeamSnapshot, TeamView, TeamWorkspaceDenied, TeamWorkspaceEvent } from "../team";

export interface MockTeamOptions {
  now?: () => number;
  /** `?team=on` in the dev URL opens the mock inside a team of three, for screenshots. */
  preset?: "off" | "on";
}

/** Drives the mock like the other side of the relay would. */
export interface MockTeamSim {
  /** Somebody scans the open invite and proves the code: the admin now compares six digits. */
  someoneArrives(name: string): string;
  /** An admin accepted the joiner (joiner side). */
  adminWelcomes(): void;
  setOnline(id: string, online: boolean): void;
  /** The relay closed the socket as "removed". */
  removedByRelay(): void;
  setAuditError(message: string | null): void;
  /** A teammate shares a new run (or an existing one changes). */
  shareRun(run: TeamRun, events?: AgentEvent[]): void;
  /** More events of a shared run arrive. */
  runEvents(memberId: string, runId: string, events: AgentEvent[]): void;
  /** The teammate withdrew the run. */
  withdrawRun(runId: string): void;
  /** A teammate sends a note into one of your runs. */
  noteIn(note: Omit<TeamNoteIn, "at" | "auto"> & { at?: number }): void;
  /** The owner's machine reports where a note you sent stands. */
  noteStatus(noteId: string, status: TeamNoteStatus, reason?: string): void;
  /** What the next `workspaceRequest` gets: a snapshot (default) or a refusal (`off`, `rate`). */
  workspaceReply(reply: "ok" | "off" | "rate"): void;
}

/** A small workspace for the dev preview: a modified file, a new file, a withheld secret file and a binary. */
export function mockSnapshot(projectKey: string, takenAt: number): TeamSnapshot {
  return {
    id: `snap-${takenAt}`,
    projectKey,
    branch: "fix/cart-total",
    ahead: 2,
    behind: 0,
    takenAt,
    truncated: false,
    files: [
      { path: "src/cart/total.ts", status: "M", truncated: false, diff: "--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n@@ -1,3 +1,3 @@\n import type { Item } from \"./types\";\n-export const total = (items: Item[]) => items.reduce((s, i) => s + i.price, 0);\n+export const total = (items: Item[]) => items.reduce((s, i) => s + i.price * i.qty, 0);\n export const count = (items: Item[]) => items.length;\n" },
      { path: "src/cart/total.test.ts", status: "U", truncated: false, diff: "--- /dev/null\n+++ b/src/cart/total.test.ts\n@@ -0,0 +1,4 @@\n+import { total } from \"./total\";\n+it(\"multiplies by the quantity\", () => {\n+  expect(total([{ price: 3, qty: 2 }])).toBe(6);\n+});\n" },
      { path: ".env.local", status: "M", truncated: false, diff: "", skipped: "secret" },
      { path: "assets/logo.png", status: "M", truncated: false, diff: "", skipped: "binary" },
    ],
  };
}

export type MockTeamHandle = TeamIpc & { sim: MockTeamSim };

const MIN = 60_000;
const reject = (code: string, message: string): Promise<never> => Promise.reject({ code, message });

const ev = (runId: string, seq: number, kind: Record<string, unknown>): AgentEvent => ({ agentId: runId, seq, ts: 1_700_000_000_000 + seq * 4000, provider: "claude", ...kind }) as unknown as AgentEvent;

/** A short run for the dev preview: a prompt, an edit with a diff, a permission card that is only shown, a test run and an answer. */
export function mockSharedRunEvents(runId: string): AgentEvent[] {
  const diff = { path: "src/cart/total.ts", old: "export const total = (items: Item[]) => items.reduce((s, i) => s + i.price, 0);\n", new: "export const total = (items: Item[]) => items.reduce((s, i) => s + i.price * i.qty, 0);\n", truncated: false };
  return [
    ev(runId, 1, { kind: "session.started", model: "claude-sonnet-5", effective: { permission: "edit" }, assertions: [], capsDelta: {} }),
    ev(runId, 2, { kind: "user.message", messageId: "u1", text: "The cart total ignores quantities. Fix it and run the tests." }),
    ev(runId, 3, { kind: "text.delta", messageId: "m1", text: "I will read the helper first, then fix the multiplication.\n" }),
    ev(runId, 3, { kind: "text.done", messageId: "m1", text: "I will read the helper first, then fix the multiplication.\n" }),
    ev(runId, 4, { kind: "tool.start", toolId: "t1", name: "Edit", toolKind: "edit", input: { file_path: "src/cart/total.ts" } }),
    ev(runId, 5, { kind: "tool.result", toolId: "t1", status: "ok", output: "Edited src/cart/total.ts", diff, durationMs: 40 }),
    ev(runId, 6, { kind: "tool.start", toolId: "t2", name: "Bash", toolKind: "exec", input: { command: "pnpm test cart" } }),
    ev(runId, 7, { kind: "permission.request", reqId: "p1", toolId: "t2", intent: { class: "exec", tool: "Bash", rawCommand: "pnpm test cart", paths: [], summary: "pnpm test cart" }, options: ["allow_once", "deny"] }),
    ev(runId, 8, { kind: "permission.resolved", reqId: "p1", outcome: "allow", by: "user" }),
    ev(runId, 9, { kind: "tool.result", toolId: "t2", status: "ok", output: "Tests: 12 passed, 12 total", durationMs: 2100 }),
    ev(runId, 10, { kind: "text.delta", messageId: "m2", text: "Fixed: the total now multiplies by the quantity. All 12 cart tests pass.\n" }),
    ev(runId, 10, { kind: "text.done", messageId: "m2", text: "Fixed: the total now multiplies by the quantity. All 12 cart tests pass.\n" }),
    ev(runId, 11, { kind: "turn.end", stopReason: "end_turn" }),
  ];
}

function presetFromUrl(): "off" | "on" {
  return new URLSearchParams(globalThis.location?.search).get("team") === "on" ? "on" : "off";
}

export function createMockTeam(options: MockTeamOptions = {}): MockTeamHandle {
  const now = options.now ?? Date.now;
  const on = (options.preset ?? presetFromUrl()) === "on";
  const me: TeamMember = { id: "m_me", name: "Sam", role: "admin", online: true, state: "", me: true };
  let view: TeamView = { state: "none", relay: "ws://127.0.0.1:8787", epoch: 0, connected: false, members: [], auditEntries: 0 };
  if (on) {
    view = {
      ...view,
      state: "member",
      teamId: "mock-team",
      epoch: 1,
      connected: true,
      role: "admin",
      auditEntries: 3,
      members: [me, { id: "m_jo", name: "Jordan", role: "member", online: true, state: "busy", me: false }, { id: "m_ri", name: "Riley", role: "member", online: false, state: "", me: false }],
    };
  }
  const mockRuns: TeamRun[] = on
    ? [
        { memberId: "m_jo", memberName: "Jordan", online: true, runId: "r_jo1", projectKey: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", projectName: "widgets", title: "Fix the cart total", state: "idle", provider: "claude", model: "claude-sonnet-5", startedAt: now() - 12 * MIN, updatedAt: now() - 2 * MIN },
        { memberId: "m_jo", memberName: "Jordan", online: true, runId: "r_jo2", projectKey: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", projectName: "widgets", title: "Add a retry to the sync job", state: "waiting", provider: "claude", model: "claude-sonnet-5", startedAt: now() - 30 * MIN, updatedAt: now() - 40_000 },
      ]
    : [];
  const eventsOf = new Map<string, AgentEvent[]>(on ? [["r_jo1", mockSharedRunEvents("r_jo1")], ["r_jo2", mockSharedRunEvents("r_jo2").slice(0, 8)]] : []);
  const runsCbs = new Set<(r: TeamRun[]) => void>();
  const runEventCbs = new Set<(e: TeamRunEvents) => void>();
  const pushRuns = () => {
    for (const cb of runsCbs) cb([...mockRuns]);
  };
  const projects: TeamProject[] = [
    { repoId: "repo-1", name: "widgets", key: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", shared: false, workspace: false, memory: false, claudeMd: false },
    { repoId: "repo-2", name: "scratch", key: null, shared: false, workspace: false, memory: false, claudeMd: false },
  ];
  const unshared = new Set<string>();
  const pending: TeamNoteIn[] = on && options.preset === undefined // the `?team=on` dev URL only: the tests start from an empty inbox
    ? [{ memberId: "m_ri", memberName: "Riley", runId: "r_me1", noteId: "tn-seed", text: "The retry should back off: please use 2 s, 4 s, 8 s and stop after three tries.", at: now() - 40_000, auto: false }]
    : [];
  const sent: TeamSentNote[] = [];
  const autoAccept = new Set<string>();
  let wsReply: "ok" | "off" | "rate" = "ok";
  const snapshots = new Map<string, TeamSnapshot>();
  const noteInCbs = new Set<(n: TeamNoteIn) => void>();
  const noteStatusCbs = new Set<(n: TeamSentNote) => void>();
  const wsCbs = new Set<(e: TeamWorkspaceEvent) => void>();
  const wsDeniedCbs = new Set<(e: TeamWorkspaceDenied) => void>();
  let seq = 0;
  const changed = new Set<(v: TeamView) => void>();
  const presence = new Set<(p: TeamPresence) => void>();
  const set = (patch: Partial<TeamView>): TeamView => {
    view = { ...view, ...patch };
    for (const cb of changed) cb(view);
    return view;
  };
  const code = () => String(100000 + ((seq * 7919) % 900000));
  let invite: TeamInvite | null = null;
  let sas = "";

  return {
    async status() {
      return view;
    },
    async members() {
      return view.members;
    },
    async create(name) {
      if (view.state !== "none") return reject("alreadyInTeam", "this install is already in a team");
      if (!name.trim()) return reject("name", "give yourself a name the team can see");
      return set({ state: "member", teamId: "mock-team", epoch: 1, connected: true, role: "admin", auditEntries: 1, members: [{ ...me, name: name.trim() }] });
    },
    async invite() {
      if (view.role !== "admin") return reject("notAdmin", "only an admin can invite");
      seq++;
      invite = { code: `intely-team://join#ws://127.0.0.1:8787,mock-team,m_me,AAAA,BBBB${seq}`, qr: "", expiresAt: now() + 10 * MIN };
      invite.qr = invite.code;
      set({ invite });
      return invite;
    },
    async join(codeText, name) {
      if (view.state !== "none") return reject("alreadyInTeam", "this install is already in a team");
      if (!codeText.startsWith("intely-team://join#")) return reject("team", "that is not a team invite code");
      if (!name.trim()) return reject("name", "give yourself a name the team can see");
      seq++;
      sas = code();
      return set({ state: "joining", teamId: "mock-team", joining: { stage: "confirm", sas } });
    },
    async joinConfirm(accept) {
      if (view.state !== "joining") return reject("noRequest", "no join is in progress");
      if (!accept) return set({ state: "none", teamId: null, joining: null });
      return set({ joining: { stage: "waitingWelcome", sas } });
    },
    async joinDecide(accept) {
      const req = view.joinRequest;
      if (!req) return reject("noRequest", "nobody is asking to join");
      if (!accept) return set({ joinRequest: null, invite: null });
      return set({ joinRequest: null, invite: null, members: [...view.members, { id: req.id, name: req.name, role: "member", online: true, state: "", me: false }], auditEntries: view.auditEntries + 1 });
    },
    async revoke(id) {
      if (view.role !== "admin") return reject("notAdmin", "only an admin can do this");
      if (!view.members.some((m) => m.id === id && m.role !== "admin")) return reject("team", "unknown member");
      return set({ members: view.members.filter((m) => m.id !== id), epoch: view.epoch + 1, auditEntries: view.auditEntries + 2 });
    },
    async leave() {
      if (view.role === "admin" && view.members.length > 1) return reject("adminLeave", "an admin cannot leave while other members remain; revoke them first");
      return set({ state: "none", teamId: null, epoch: 0, connected: false, role: null, members: [], invite: null, joinRequest: null, joining: null });
    },
    async forget() {
      if (view.role === "admin" && view.members.length > 1) return reject("adminLeave", "an admin cannot forget the team while other members remain; revoke them first");
      return set({ state: "none", teamId: null, epoch: 0, connected: false, role: null, members: [], invite: null, joinRequest: null, joining: null, removed: false });
    },
    async runs() {
      return [...mockRuns];
    },
    async runEvents(_memberId, runId) {
      return eventsOf.get(runId) ?? [];
    },
    async projects() {
      return projects.map((p) => ({ ...p }));
    },
    async setShare(key, shared) {
      const p = projects.find((x) => x.key === key);
      if (!p) return reject("invalid", "not a project key");
      p.shared = shared;
    },
    async runShareState(runId) {
      const available = view.state === "member" && projects.some((p) => p.shared);
      return { available, shared: available && !unshared.has(runId) };
    },
    async runShare(runId, shared) {
      if (shared) unshared.delete(runId);
      else unshared.add(runId);
    },
    async pendingNotes() {
      return pending.map((n) => ({ ...n }));
    },
    async noteDecide(memberId, noteId, accept) {
      const i = pending.findIndex((n) => n.memberId === memberId && n.noteId === noteId);
      if (i < 0) return reject("unknownNote", "that note is no longer waiting");
      pending.splice(i, 1);
      void accept;
    },
    async noteSend(memberId, runId, text) {
      const member = view.members.find((m) => m.id === memberId);
      if (!member || member.me) return reject("unknownMember", "that member is not in the team");
      if (!member.online) return reject("offline", "that member is offline");
      const run = mockRuns.find((r) => r.memberId === memberId && r.runId === runId);
      if (!run || run.provider !== "claude" || (run.state !== "running" && run.state !== "waiting")) return reject("notLive", "notes go only into runs of Claude that are working");
      const body = text.trim();
      if (!body || body.length > 3800) return reject("noteInvalid", "a note must not be empty and is at most 3800 characters");
      seq++;
      const note: TeamSentNote = { memberId, runId, noteId: `tn-${seq}`, status: "sent", at: now() };
      sent.push(note);
      return note.noteId;
    },
    async sentNotes(memberId, runId) {
      return sent.filter((n) => n.memberId === memberId && n.runId === runId).map((n) => ({ ...n }));
    },
    async collabSettings() {
      return { autoAcceptNotesFrom: [...autoAccept] };
    },
    async setAutoAccept(memberId, enabled) {
      if (enabled) autoAccept.add(memberId);
      else autoAccept.delete(memberId);
    },
    async setWorkspace(key, enabled) {
      const p = projects.find((x) => x.key === key);
      if (!p) return reject("invalid", "not a project key");
      p.workspace = enabled;
    },
    async setClaudeMd(key, enabled) {
      const p = projects.find((x) => x.key === key);
      if (!p) return reject("invalid", "not a project key");
      p.claudeMd = enabled;
    },
    async setMemory(key, enabled) {
      const p = projects.find((x) => x.key === key);
      if (!p) return reject("invalid", "not a project key");
      p.memory = enabled;
    },
    memory: createMockTeamMemory(now),
    async workspaceRequest(memberId, projectKey) {
      const member = view.members.find((m) => m.id === memberId);
      if (!member || member.me) return reject("unknownMember", "that member is not in the team");
      if (!member.online) return reject("offline", "that member is offline");
      queueMicrotask(() => {
        if (wsReply !== "ok") {
          for (const cb of wsDeniedCbs) cb({ memberId, projectKey, reason: wsReply });
          return;
        }
        const snapshot = mockSnapshot(projectKey, now());
        snapshots.set(`${memberId}:${projectKey}`, snapshot);
        for (const cb of wsCbs) cb({ memberId, snapshot });
      });
    },
    async workspace(memberId, projectKey) {
      return snapshots.get(`${memberId}:${projectKey}`) ?? null;
    },
    onNoteIn(cb) {
      noteInCbs.add(cb);
      return () => void noteInCbs.delete(cb);
    },
    onNoteStatus(cb) {
      noteStatusCbs.add(cb);
      return () => void noteStatusCbs.delete(cb);
    },
    onWorkspace(cb) {
      wsCbs.add(cb);
      return () => void wsCbs.delete(cb);
    },
    onWorkspaceDenied(cb) {
      wsDeniedCbs.add(cb);
      return () => void wsDeniedCbs.delete(cb);
    },
    onRuns(cb) {
      runsCbs.add(cb);
      return () => void runsCbs.delete(cb);
    },
    onRunEvents(cb) {
      runEventCbs.add(cb);
      return () => void runEventCbs.delete(cb);
    },
    onChanged(cb) {
      changed.add(cb);
      return () => void changed.delete(cb);
    },
    onPresence(cb) {
      presence.add(cb);
      return () => void presence.delete(cb);
    },
    sim: {
      someoneArrives(name) {
        seq++;
        sas = code();
        set({ joinRequest: { id: `m_new${seq}`, name, sas } });
        return sas;
      },
      adminWelcomes() {
        set({ state: "member", joining: null, epoch: 1, connected: true, role: "member", members: [{ id: "m_ad", name: "Admin", role: "admin", online: true, state: "", me: false }, { ...me, role: "member" }] });
      },
      removedByRelay() {
        set({ removed: true, connected: false });
      },
      setAuditError(message) {
        set({ auditError: message });
      },
      shareRun(run, events) {
        const i = mockRuns.findIndex((r) => r.runId === run.runId);
        if (i >= 0) mockRuns[i] = run;
        else mockRuns.push(run);
        if (events) eventsOf.set(run.runId, events);
        pushRuns();
      },
      runEvents(memberId, runId, events) {
        eventsOf.set(runId, [...(eventsOf.get(runId) ?? []), ...events]);
        for (const cb of runEventCbs) cb({ memberId, runId, events });
      },
      noteIn(n) {
        const note: TeamNoteIn = { ...n, at: n.at ?? now(), auto: autoAccept.has(n.memberId) };
        if (!note.auto) pending.push(note);
        for (const cb of noteInCbs) cb(note);
      },
      noteStatus(noteId, status, reason) {
        const n = sent.find((x) => x.noteId === noteId);
        if (!n) return;
        n.status = status;
        n.reason = reason ?? null;
        for (const cb of noteStatusCbs) cb({ ...n });
      },
      workspaceReply(reply) {
        wsReply = reply;
      },
      withdrawRun(runId) {
        const i = mockRuns.findIndex((r) => r.runId === runId);
        if (i >= 0) mockRuns.splice(i, 1);
        eventsOf.delete(runId);
        pushRuns();
      },
      setOnline(id, online) {
        set({ members: view.members.map((m) => (m.id === id ? { ...m, online } : m)) });
        for (const cb of presence) cb({ id, online, state: "" });
      },
    },
  };
}
