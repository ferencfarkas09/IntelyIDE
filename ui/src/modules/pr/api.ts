// Backend of the PR bridge: the `gitx_*` commands in the app, a deterministic fixture in a plain browser (and in tests,
// which can swap it with `setPrApi`). `?pr=<scenario>` picks a mock scenario for screenshots: noGh, noAuth, readOnly,
// noUpstream, liveHead, empty.
import { call } from "../../ipc/rpc";
import { repos } from "../../store/workspace";
import { inTauri } from "../l10n/api";
import type { CreatePlan, CreateRequest, CreateResult, GhStatus, PrDetail, PrList, PrSummary } from "./types";

export interface PrApi {
  status(repoId: string): Promise<GhStatus>;
  list(repoId: string): Promise<PrList>;
  view(repoId: string, number: number): Promise<PrDetail>;
  plan(repoId: string, base: string | null, draft: boolean): Promise<CreatePlan>;
  preview(repoId: string, req: CreateRequest): Promise<string>;
  create(repoId: string, req: CreateRequest): Promise<CreateResult>;
  openUrl(url: string): Promise<void>;
}

const tauriApi: PrApi = {
  status: (repoId) => call("gitx_gh_status", { repoId }),
  list: (repoId) => call("gitx_pr_list", { repoId }),
  view: (repoId, number) => call("gitx_pr_view", { repoId, number }),
  plan: (repoId, base, draft) => call("gitx_pr_plan", { repoId, base, draft }),
  preview: (repoId, req) => call("gitx_pr_preview", { repoId, req }),
  create: (repoId, req) => call("gitx_pr_create", { repoId, req }),
  openUrl: (url) => call("gitx_open_url", { url }),
};

let override: PrApi | undefined;
export const setPrApi = (api: PrApi | undefined): void => void (override = api);

let mock: PrApi | undefined;
export function prApi(): PrApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockPr(scenarioFromUrl()));
}

function scenarioFromUrl(): string {
  try {
    return new URLSearchParams(location.search).get("pr") ?? "normal";
  } catch {
    return "normal";
  }
}

const nameOf = (id: string): string => repos().find((r) => r.id === id)?.name ?? id;
const refuse = (code: string, message: string) => Promise.reject({ code, message });

const pr = (o: Partial<PrSummary> & Pick<PrSummary, "number" | "title" | "head">): PrSummary => ({
  state: "OPEN", isDraft: false, base: "main", author: "ferenc", url: `https://github.com/example-org/repo/pull/${o.number}`, review: "none", ci: "none",
  checksPassed: 0, checksFailed: 0, checksPending: 0, updatedAt: "2026-10-03T10:00:00Z", ...o,
});

/** Shape of `crates/gitx` output with a branch that has two commits, one draft PR on it and two more of the user. */
export function createMockPr(scenario = "normal"): PrApi {
  const current = [pr({ number: 412, title: "feat(billing): invoice PDF export", head: "feature/invoice-pdf", isDraft: true, review: "reviewRequired", ci: "pending", checksPassed: 5, checksPending: 2 })];
  const mine = [
    ...current,
    pr({ number: 409, title: "fix(pos): round the delivery fee", head: "fix/delivery-fee", review: "approved", ci: "passing", checksPassed: 8 }),
    pr({ number: 398, title: "chore: bump the expo SDK", head: "chore/expo-sdk", base: "sandbox", review: "changesRequested", ci: "failing", checksPassed: 6, checksFailed: 2 }),
  ];
  const detail = (n: number): PrDetail => {
    const summary = mine.find((p) => p.number === n) ?? mine[0];
    return {
      summary,
      body: "Extended English: This pull request brings 2 commits from `feature/invoice-pdf` into `main`. Adds the invoice PDF export.\n\nCommits:\n- feat(billing): add the invoice model (a1b2c3d)\n- feat(billing): render the invoice PDF (d4e5f6a)",
      reviews: [{ author: "anna", state: "APPROVED" }, { author: "bela", state: "COMMENTED" }],
      checks: [
        { name: "lint", workflow: "CI", state: "SUCCESS", bucket: "pass", link: "https://github.com/example-org/repo/actions/runs/101" },
        { name: "jest (node 24)", workflow: "CI", state: "SUCCESS", bucket: "pass", link: "https://github.com/example-org/repo/actions/runs/102" },
        { name: "build", workflow: "CI", state: "IN_PROGRESS", bucket: "pending", link: "https://github.com/example-org/repo/actions/runs/103" },
        { name: "e2e", workflow: "CI", state: "FAILURE", bucket: "fail", link: "https://github.com/example-org/repo/actions/runs/104" },
      ],
    };
  };
  const refusal = scenario === "noUpstream"
    ? { code: "noUpstream", message: "'wip/invoice' has no upstream: push it from the Push dialog first, this never pushes" }
    : scenario === "liveHead"
      ? { code: "liveHead", message: "'main' is a live branch: it can be the base of a PR, never the head" }
      : scenario === "readOnly"
        ? { code: "readOnly", message: "read-only mode (INTELY_READONLY): 'gh pr create' is refused" }
        : null;
  const head = scenario === "noUpstream" ? "wip/invoice" : scenario === "liveHead" ? "main" : "feature/invoice-pdf";
  const q = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  const command = (base: string, title: string, body: string, draft: boolean) => `gh pr create${draft ? " --draft" : ""} --base=${q(base)} --head=${q(head)} --title=${q(title)} --body=${q(body)}`;
  const title = "feat(billing): invoice PDF export";
  const body = "Extended English: This pull request brings 2 commits from `feature/invoice-pdf` into `main`.\n\nCommits:\n- feat(billing): add the invoice model (a1b2c3d)\n- feat(billing): render the invoice PDF (d4e5f6a)";
  return {
    status: async () => ({
      installed: scenario !== "noGh",
      version: scenario === "noGh" ? null : "2.80.0",
      path: scenario === "noGh" ? null : "/opt/homebrew/bin/gh",
      authenticated: scenario === "noGh" || scenario === "readOnly" ? null : scenario !== "noAuth",
      blocked: scenario === "readOnly" ? "readOnly" : null,
    }),
    list: async () => (scenario === "readOnly" ? refuse("readOnly", "read-only mode (INTELY_READONLY): no GitHub call runs") : scenario === "empty" ? { branch: "feature/invoice-pdf", current: [], mine: [] } : { branch: "feature/invoice-pdf", current: structuredClone(current), mine: structuredClone(mine) }),
    view: async (_r, n) => structuredClone(detail(n)),
    plan: async (_r, base, draft) => ({
      repoName: nameOf(_r),
      head,
      base: base ?? "main",
      bases: ["main", "sandbox", "release/3.88"],
      upstream: scenario === "noUpstream" ? null : `origin/${head}`,
      unpushed: scenario === "normal" ? 1 : 0,
      commits: [{ sha: "a1b2c3d4e5f6", subject: "feat(billing): add the invoice model" }, { sha: "d4e5f6a7b8c9", subject: "feat(billing): render the invoice PDF" }],
      title,
      body,
      draft,
      command: command(base ?? "main", title, body, draft),
      refusal,
    }),
    preview: async (_r, req) => command(req.base, req.title, req.body, req.draft),
    create: async (r, req) => {
      if (refusal) return refuse(refusal.code, refusal.message);
      if (req.confirmRepo !== nameOf(r) || req.confirmHead !== head) return refuse("confirmRequired", `type the repo name ${nameOf(r)} and the head branch ${head} to confirm`);
      return { url: "https://github.com/example-org/repo/pull/413", command: command(req.base, req.title, req.body, req.draft) };
    },
    openUrl: async () => undefined,
  };
}
