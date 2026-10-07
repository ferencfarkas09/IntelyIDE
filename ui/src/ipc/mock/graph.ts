import type { BranchMatrix, GraphIpc, GraphRow, LaneEdge, OpOutcome, RefDecoration } from "../graph";

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

const oid = (repoId: string, n: number): string => `${repoId.charCodeAt(0).toString(16).padStart(2, "0")}${n.toString(16).padStart(2, "0")}`.repeat(10);
const edge = (kind: LaneEdge["kind"], from: number, to: number, color: number): LaneEdge => ({ kind, from, to, color });

interface Spec {
  n: number;
  subject: string;
  parents: number[];
  lane: number;
  color: number;
  edges: LaneEdge[];
  width: number;
  refs?: RefDecoration[];
}

/** main: base - a1 - a2 - merge(a2, b1), side branch b1 from a1; newest first. */
const SPECS: Spec[] = [
  { n: 5, subject: "Merge branch 'feature/loyalty'", parents: [4, 3], lane: 0, color: 0, width: 2, edges: [edge("down", 0, 0, 0), edge("down", 0, 1, 1)], refs: [{ name: "main", kind: "branch", current: true }, { name: "origin/main", kind: "remote", current: false }] },
  { n: 4, subject: "Fix rounding in totals", parents: [2], lane: 0, color: 0, width: 2, edges: [edge("up", 0, 0, 0), edge("down", 0, 0, 0), edge("through", 1, 1, 1)] },
  { n: 3, subject: "Add loyalty service", parents: [2], lane: 1, color: 1, width: 2, edges: [edge("up", 1, 1, 1), edge("through", 0, 0, 0), edge("down", 1, 0, 1)], refs: [{ name: "feature/loyalty", kind: "branch", current: false }] },
  { n: 2, subject: "Add receipt printer", parents: [1], lane: 0, color: 0, width: 1, edges: [edge("up", 0, 0, 0), edge("down", 0, 0, 0)], refs: [{ name: "v1.2.0", kind: "tag", current: false }] },
  { n: 1, subject: "Initial import", parents: [], lane: 0, color: 0, width: 1, edges: [edge("up", 0, 0, 0)] },
];

function rowsOf(repoId: string, offset: number): GraphRow[] {
  return SPECS.map((s) => ({
    repoId,
    oid: oid(repoId, s.n),
    shortOid: oid(repoId, s.n).slice(0, 8),
    parents: s.parents.map((p) => oid(repoId, p)),
    subject: s.subject,
    author: "Fixture Author",
    authorEmail: "fixture@example.invalid",
    dateMs: T0 + s.n * DAY + offset,
    refs: (s.refs ?? []).map((r) => r.name),
    decorations: s.refs ?? [],
    lane: s.lane,
    color: s.color,
    edges: s.edges,
    width: s.width,
  }));
}

const REPOS = [
  { repoId: "api", name: "api", color: "#4f8cff", badge: "A" },
  { repoId: "web", name: "web", color: "#ff8c4f", badge: "W" },
];

const idle = (repoId: string): OpOutcome => ({ repoId, kind: "none", status: "idle", step: 0, total: 0, conflictFiles: [] });

export function createMockGraph(): GraphIpc {
  const ops = new Map<string, OpOutcome>();
  return {
    async logPage(repoIds, cursor, filters, limit = 500) {
      const ids = repoIds.length ? repoIds : REPOS.map((r) => r.repoId);
      let all = ids.flatMap((id, i) => rowsOf(id, i * 3_600_000)).sort((a, b) => b.dateMs - a.dateMs);
      const text = filters?.text?.toLowerCase();
      if (text) all = all.filter((r) => r.subject.toLowerCase().includes(text));
      const author = filters?.author?.toLowerCase();
      if (author) all = all.filter((r) => r.author.toLowerCase().includes(author));
      if (filters?.sinceMs != null) all = all.filter((r) => r.dateMs >= filters.sinceMs!);
      if (filters?.untilMs != null) all = all.filter((r) => r.dateMs <= filters.untilMs!);
      // Mock rule: the side branch holds the loyalty commits (n 3 and below); any other branch sees the whole history.
      if (filters?.branch === "feature/loyalty") all = all.filter((r) => SPECS.some((s) => oid(r.repoId, s.n) === r.oid && s.n <= 3));
      const start = cursor ? Number(cursor) : 0;
      const rows = all.slice(start, start + limit);
      return { rows, nextCursor: start + limit < all.length ? String(start + limit) : undefined, repos: REPOS.filter((r) => ids.includes(r.repoId)) };
    },
    async commitDetail(repoId, id) {
      const spec = SPECS.find((s) => oid(repoId, s.n) === id);
      const subject = spec?.subject ?? "Fixture commit";
      const n = spec?.n ?? 0;
      return {
        repoId,
        oid: id,
        shortOid: id.slice(0, 8),
        parents: (spec?.parents ?? []).map((p) => oid(repoId, p)),
        subject,
        message: `${subject}\n\nWhy: the fixture needs a believable body.\nThe change touches ${2 + (n % 2)} files.`,
        author: "Fixture Author",
        authorEmail: "fixture@example.invalid",
        dateMs: T0 + n * DAY,
        refs: (spec?.refs ?? []).map((r) => r.name),
        decorations: spec?.refs ?? [],
        files: [
          { path: "src/index.ts", kind: "modified", additions: 12, deletions: 3, binary: false },
          { path: "src/orders/service.ts", kind: "added", additions: 40, deletions: 0, binary: false },
          ...(n % 2 ? [{ path: "assets/logo.png", kind: "added" as const, binary: true }] : []),
        ],
        additions: 52,
        deletions: 3,
      };
    },
    blame: async () => [
      { line: 1, oid: oid("api", 1), author: "Fixture Author", authorEmail: "fixture@example.invalid", dateMs: T0, summary: "Initial import", text: "export const answer = 42;", boundary: true, uncommitted: false },
    ],
    blameCaret: async (_repoId, _path, line) => ({
      line,
      oid: oid("api", 1),
      shortOid: oid("api", 1).slice(0, 8),
      author: "Fixture Author",
      authorEmail: "fixture@example.invalid",
      dateMs: T0,
      relativeTime: "3 days ago",
      subject: "Initial import",
      uncommitted: false,
    }),
    fileHistory: async (repoId) => rowsOf(repoId, 0),
    async rebasePlan(repoId) {
      const steps = rowsOf(repoId, 0)
        .filter((r) => r.parents.length < 2)
        .reverse()
        .map((r) => ({ action: "pick" as const, oid: r.oid, subject: r.subject }));
      return { repoId, onto: "main", steps };
    },
    async rebaseRun(plan) {
      if (ops.get(plan.repoId)?.status === "conflict") return Promise.reject({ code: "git", message: "A rebase is already in progress" });
      const first = plan.steps.find((s) => s.action !== "drop");
      if (first && (first.action === "squash" || first.action === "fixup"))
        return Promise.reject({ code: "invalidArgument", message: "the first kept commit cannot be squashed or fixed up: there is nothing before it" });
      if (plan.steps.some((s) => s.action === "reword" && !s.message?.trim()))
        return Promise.reject({ code: "invalidArgument", message: "reword needs a message" });
      // Mock rule: a plan that moves commits stops with a conflict on the first moved step; any other plan applies cleanly.
      const original = rowsOf(plan.repoId, 0).filter((r) => r.parents.length < 2).reverse().map((r) => r.oid);
      const moved = plan.steps.findIndex((s, i) => original[i] !== s.oid);
      if (moved >= 0 && original.length === plan.steps.length) {
        const stopped: OpOutcome = { repoId: plan.repoId, kind: "rebase", status: "conflict", step: moved + 1, total: plan.steps.length, conflictFiles: ["src/orders/service.ts"] };
        ops.set(plan.repoId, stopped);
        return stopped;
      }
      return { ...idle(plan.repoId), kind: "rebase", status: "done" };
    },
    async rebaseAbort(repoId) {
      ops.delete(repoId);
      return idle(repoId);
    },
    async rebaseContinue(repoId) {
      ops.delete(repoId);
      return { ...idle(repoId), kind: "rebase", status: "done" };
    },
    opState: async (repoId) => ops.get(repoId) ?? idle(repoId),
    async rebaseStatus(repoId) {
      const o = ops.get(repoId);
      return o ? { state: "conflict", step: o.step, total: o.total, conflicts: o.conflictFiles } : { state: "idle", step: 0, total: 0, conflicts: [] };
    },
    revertHunk: async () => {},
    cherryPick: async (repoId) => ({ ...idle(repoId), status: "done" }),
    cherryPickAbort: async (repoId) => idle(repoId),
    cherryPickContinue: async (repoId) => ({ ...idle(repoId), status: "done" }),
    async branchMatrix(repoIds) {
      const ids = repoIds?.length ? repoIds : REPOS.map((r) => r.repoId);
      const cell = (exists: boolean, current = false) => ({ exists, current, ahead: 0, behind: 0, gone: false });
      const matrix: BranchMatrix = {
        repos: ids.map((repoId) => ({ repoId, current: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0, gone: false })),
        branches: [
          { name: "feature/loyalty", inAll: ids.length === 1, cells: Object.fromEntries(ids.map((id, i) => [id, cell(i === 0)])) },
          { name: "main", inAll: true, cells: Object.fromEntries(ids.map((id) => [id, cell(true, true)])) },
        ],
      };
      return matrix;
    },
    sameBranchCreate: async (repoIds, name) => ({ branch: name, applied: true, repos: repoIds.map((repoId) => ({ repoId, ok: true })) }),
    sameBranchSwitch: async (repoIds, name) => ({ branch: name, applied: true, repos: repoIds.map((repoId) => ({ repoId, ok: true })) }),
    bundles: async () => [
      {
        id: "h-mock",
        name: "Add loyalty service",
        source: "heuristic",
        createdMs: T0,
        repoIds: ["api", "web"],
        commits: ["api", "web"].map((repoId) => ({ repoId, oid: oid(repoId, 3), shortOid: oid(repoId, 3).slice(0, 8), subject: "Add loyalty service", dateMs: T0, missing: false })),
      },
    ],
    bundleRecord: async (links, name) => ({
      id: "r-mock",
      name: name ?? "Recorded bundle",
      source: "recorded",
      createdMs: T0,
      repoIds: links.map((l) => l.repoId),
      commits: links.map((l) => ({ repoId: l.repoId, oid: l.oid, shortOid: l.oid.slice(0, 8), subject: "Recorded", dateMs: T0, missing: false })),
    }),
    bundleRemove: async () => {},
    async validateMessage(message) {
      const ok = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: \S/.test(message);
      return { ok, issues: ok ? [] : [{ severity: "error", code: "header.format", message: "the first line must look like `type(scope): description`" }] };
    },
    messageTemplate: async (style, subject) => {
      const header = subject?.trim() || "type(scope): description";
      return style === "extended" ? `${header}\n\nExtended English: \n\nMagyar bővített leírás: \n` : `${header}\n`;
    },
    draftMessage: async () => "Update fixture",
    draftMessageDetailed: async (_repoId, selection) => ({
      message: `chore: update ${selection.length} file(s)\n\nExtended English: Updates ${selection.length} file(s).\n\nMagyar bővített leírás: ${selection.length} fájl módosul.\n`,
      source: "template",
      note: "no utility model is available: template draft",
      issues: [],
    }),
  };
}
