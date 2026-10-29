import { createResource, For, Show } from "solid-js";
import { t } from "../../../i18n";
import { execute } from "../../../platform/commands";
import type { WidgetProps } from "../../../platform/widgets";
import { repos } from "../../../store/workspace";
import { Badge, GitPullRequestArrow, StatusDot } from "../../../ui-kit";
import { prApi } from "../../pr/api";
import type { CiState, PrSummary } from "../../pr/types";
import { CardEmpty, CardError, CardLoading, errorText } from "../parts";

export interface PrRow {
  repoId: string;
  repoName: string;
  pr: PrSummary;
}

export type PrLoad = { state: "noGh" } | { state: "blocked"; code: string } | { state: "ok"; rows: PrRow[] };

/** At most this many repositories are asked: every list is a `gh` call. */
const MAX_REPOS = 4;

/** The open pull requests of the current branches and of the user, newest first; `noGh` when the GitHub CLI is missing. */
export async function loadPrs(): Promise<PrLoad> {
  const list = repos().slice(0, MAX_REPOS);
  if (!list.length) return { state: "ok", rows: [] };
  const api = prApi();
  const status = await api.status(list[0].id);
  if (!status.installed) return { state: "noGh" };
  if (status.blocked) return { state: "blocked", code: status.blocked };
  const rows: PrRow[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const l = await api.list(r.id);
    for (const pr of [...l.current, ...l.mine]) {
      if (pr.state !== "OPEN" || seen.has(pr.url)) continue;
      seen.add(pr.url);
      rows.push({ repoId: r.id, repoName: r.name, pr });
    }
  }
  rows.sort((a, b) => b.pr.updatedAt.localeCompare(a.pr.updatedAt));
  return { state: "ok", rows };
}

const CI_TONE: Record<CiState, "ok" | "danger" | "warn" | "neutral"> = { passing: "ok", failing: "danger", pending: "warn", none: "neutral" };
const CI_KEY = { passing: "dash.prs.ci.passing", failing: "dash.prs.ci.failing", pending: "dash.prs.ci.pending", none: "dash.prs.ci.none" } as const;

/** CI & PRs: the open pull requests with their checks, from the PR bridge (GitHub CLI). */
export default function PullRequests(props: WidgetProps) {
  const [data, { refetch }] = createResource(props.refreshTick, () => loadPrs());
  const limit = () => (props.size === "s" ? 3 : props.size === "m" ? 5 : 10);
  const open = () => void execute("pr.open");
  return (
    <Show when={data.state !== "unresolved" && data.state !== "pending"} fallback={<CardLoading />}>
      <Show when={data.state !== "errored"} fallback={<CardError message={errorText(data.error)} onRetry={() => void refetch()} />}>
        <Show when={data.latest}>
          {(d) => (
            <Show
              when={d().state === "ok" && (d() as Extract<PrLoad, { state: "ok" }>)}
              fallback={
                <CardEmpty
                  icon={GitPullRequestArrow}
                  title={d().state === "noGh" ? t("dash.prs.noGh") : t("dash.prs.blocked")}
                  why={d().state === "noGh" ? t("dash.prs.noGhWhy") : t("dash.prs.blockedWhy")}
                />
              }
            >
              {(ok) => (
                <Show when={ok().rows.length > 0} fallback={<CardEmpty icon={GitPullRequestArrow} title={t("dash.prs.empty")} why={t("dash.prs.emptyWhy")} />}>
                  <ul class="dash-list">
                    <For each={ok().rows.slice(0, limit())}>
                      {(row) => (
                        <li>
                          <button type="button" class="dash-row" onClick={open}>
                            <StatusDot tone={CI_TONE[row.pr.ci]} label={t(CI_KEY[row.pr.ci])} />
                            <span class="dash-row__main">
                              <span class="dash-row__title">
                                <span class="ui-truncate">{row.pr.title}</span>
                                <Show when={row.pr.isDraft}>
                                  <Badge size="sm">{t("dash.prs.draft")}</Badge>
                                </Show>
                              </span>
                              <span class="dash-row__sub ui-truncate">
                                {row.repoName} #{row.pr.number} · {t(CI_KEY[row.pr.ci])}
                              </span>
                            </span>
                            <Show when={row.pr.review === "changesRequested" || row.pr.review === "approved"}>
                              <Badge size="sm" tone={row.pr.review === "approved" ? "ok" : "warn"}>
                                {row.pr.review === "approved" ? t("dash.prs.approved") : t("dash.prs.changes")}
                              </Badge>
                            </Show>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </Show>
          )}
        </Show>
      </Show>
    </Show>
  );
}
