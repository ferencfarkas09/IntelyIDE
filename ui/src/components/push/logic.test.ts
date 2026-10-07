import { describe, expect, it } from "vitest";
import type { OutgoingInfo, RepoSnapshot } from "../../ipc";
import { buildPushRequest, canConfirmForce, liveConfirmed, liveRows, defaultChecks, forceRows, isPushable, outgoingLabel, requiresPreview, splitPath, timeAgo } from "./logic";

const commit = (oid: string) => ({ oid, shortOid: oid.slice(0, 7), subject: `s ${oid}`, author: "A", dateMs: 0 });
const plan = (repoId: string, o: Partial<OutgoingInfo> = {}): OutgoingInfo => ({
  repoId,
  local: "sandbox",
  remote: "origin",
  remoteBranch: "sandbox",
  newRemoteBranch: false,
  protected: false,
  commits: [commit("aaaaaaaa")],
  checkedByDefault: true,
  canPush: true,
  ...o,
});

const plans = [
  plan("backend"),
  plan("admin", { remoteBranch: "main", protected: true }),
  plan("services", { commits: [], checkedByDefault: false }),
  plan("pos", { canPush: false, blockedReason: "Detached HEAD" }),
];

describe("defaultChecks", () => {
  it("ticks repos with outgoing commits and leaves the others unticked", () => {
    expect(defaultChecks(plans)).toEqual({ backend: true, admin: true, services: false, pos: false });
  });
  it("limits the ticks to the preselected repos, never ticking an unpushable one", () => {
    expect(defaultChecks(plans, ["backend", "services", "pos"])).toEqual({ backend: true, admin: false, services: false, pos: false });
  });
  it("reports which repos can be selected", () => {
    expect(plans.map(isPushable)).toEqual([true, true, false, false]);
  });
});

describe("requiresPreview", () => {
  const plain = [plan("a"), plan("b")];
  const withProtected = [plan("a"), plan("b", { protected: true })];
  it("always previews when a target is protected, whatever the toggle says", () => {
    expect(requiresPreview(withProtected, false)).toBe(true);
    expect(requiresPreview(withProtected, true)).toBe(true);
  });
  it("previews non-protected targets only while the toggle is on", () => {
    expect(requiresPreview(plain, true)).toBe(true);
    expect(requiresPreview(plain, false)).toBe(false);
  });
  it("ignores protected repos that have nothing to push", () => {
    expect(requiresPreview([plan("a"), plan("b", { protected: true, commits: [] })], false)).toBe(false);
  });
});

describe("buildPushRequest", () => {
  it("pushes only ticked, pushable repos and maps hooks, tags and targets", () => {
    const req = buildPushRequest({ runId: "r", plans, checks: { backend: true, admin: false, services: true, pos: true }, tags: "follow", runHooks: false });
    expect(req).toEqual({
      runId: "r",
      noVerify: true,
      targets: [{ repoId: "backend", remote: "origin", remoteBranch: "sandbox", tags: "follow", forceWithLease: undefined }],
    });
  });
  it("leaves hooks on when asked and adds a lease only for the forced repos", () => {
    const req = buildPushRequest({ runId: "r", plans, checks: { backend: true, admin: true }, tags: "none", runHooks: true, force: ["admin"] });
    expect(req.noVerify).toBe(false);
    expect(req.targets.map((t) => [t.repoId, t.remoteBranch, t.forceWithLease])).toEqual([
      ["backend", "sandbox", undefined],
      ["admin", "main", { seenOid: "" }],
    ]);
  });
});

describe("force push confirmation", () => {
  const snaps = {
    backend: { upstream: { remote: "origin", branch: "sandbox", gone: false }, behind: 3 },
    admin: { upstream: { remote: "origin", branch: "other", gone: false }, behind: 5 },
  } as unknown as Record<string, RepoSnapshot>;
  const rows = forceRows(plans, { backend: true, admin: true, services: true }, (id) => id.toUpperCase(), snaps);

  it("lists the ticked repos with the number of remote commits that would be overwritten", () => {
    expect(rows.map((r) => [r.repoName, r.target, r.protected, r.overwritten])).toEqual([
      ["BACKEND", "origin/sandbox", false, 3],
      // The snapshot's upstream is a different branch, so the count is unknown rather than wrong.
      ["ADMIN", "origin/main", true, null],
    ]);
  });
  it("prefers the engine's count of remote-only commits, also for a differently named branch", () => {
    const counted = forceRows(plans.map((p) => ({ ...p, remoteOnly: p.repoId === "admin" ? 2 : undefined })), { admin: true }, (id) => id, snaps);
    expect(counted.map((r) => r.overwritten)).toEqual([2]);
  });
  it("needs the branch name typed for protected branches only", () => {
    expect(canConfirmForce(rows, {})).toBe(false);
    expect(canConfirmForce(rows, { admin: "mai" })).toBe(false);
    expect(canConfirmForce(rows, { admin: " main " })).toBe(false);
    expect(canConfirmForce(rows, { admin: "main" })).toBe(true);
    expect(canConfirmForce(rows.filter((r) => !r.protected), {})).toBe(true);
    expect(canConfirmForce([], {})).toBe(false);
  });
});

describe("labels", () => {
  it("summarises outgoing commits", () => {
    expect(outgoingLabel(plan("a"))).toBe("1 commit");
    expect(outgoingLabel(plan("a", { commits: [commit("1"), commit("2")], newRemoteBranch: true }))).toBe("2 commits · new branch");
    expect(outgoingLabel(plan("a", { commits: [] }))).toBe("Nothing to push");
    expect(outgoingLabel(plan("a", { canPush: false, blockedReason: "Detached HEAD" }))).toBe("Detached HEAD");
  });
  it("formats ages and paths", () => {
    expect(timeAgo(1_000_000, 1_000_000 + 30_000)).toBe("just now");
    expect(timeAgo(0, 5 * 60_000)).toBe("5 min ago");
    expect(timeAgo(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(timeAgo(0, 2 * 86_400_000)).toBe("2 d ago");
    expect(splitPath("a/b/c.ts")).toEqual({ dir: "a/b", name: "c.ts" });
    expect(splitPath("c.ts")).toEqual({ dir: "", name: "c.ts" });
  });
});

describe("live branch confirmation", () => {
  const live = [plan("backend", { protected: true, remoteBranch: "main" }), plan("admin")];
  const name = (id: string) => id.toUpperCase();
  it("lists the ticked pushable live targets only", () => {
    expect(liveRows(live, { backend: true, admin: true }, name)).toEqual([{ repoId: "backend", repoName: "BACKEND", branch: "main" }]);
    expect(liveRows(live, { backend: false, admin: true }, name)).toEqual([]);
  });
  it("needs the exact name (no trimming, case sensitive)", () => {
    const rows = liveRows(live, { backend: true }, name);
    expect(liveConfirmed(rows, {})).toBe(false);
    for (const v of ["Main", "main ", " main", "mai"]) expect(liveConfirmed(rows, { backend: v })).toBe(false);
    expect(liveConfirmed(rows, { backend: "main" })).toBe(true);
    expect(liveConfirmed([], {})).toBe(true);
  });
  it("sends confirmLive only for live targets that were typed", () => {
    const req = buildPushRequest({ runId: "r", plans: live, checks: { backend: true, admin: true }, tags: "none", runHooks: true, confirm: { backend: "main", admin: "sandbox" } });
    expect(req.targets.map((t) => [t.repoId, t.confirmLive])).toEqual([["backend", "main"], ["admin", undefined]]);
  });
});
