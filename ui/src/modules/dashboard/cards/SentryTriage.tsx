import { createResource, createSignal, For, Show } from "solid-js";
import { fmt, t } from "../../../i18n";
import type { WidgetProps } from "../../../platform/widgets";
import { Badge, Bug, Button, Wrench } from "../../../ui-kit";
import { fixIssue } from "../../intelyfix/fix";
import { problemOf, sentryApi } from "../../sentry/api";
import { openSentry } from "../../sentry/open";
import type { SentryIssue } from "../../sentry/types";
import { causeOf, CardEmpty, CardError, CardLoading } from "../parts";

const LEVEL_TONE: Record<string, "danger" | "warn" | "info" | "neutral"> = { fatal: "danger", error: "danger", warning: "warn", info: "info" };

/** Sentry triage: the busiest unresolved issues nobody has taken in the last 24 hours, with IntelyFIX's one-click Fix. */
export default function SentryTriage(props: WidgetProps) {
  const limit = () => (props.size === "s" ? 3 : props.size === "m" ? 4 : 8);
  const [data, { refetch }] = createResource(props.refreshTick, async () => (await sentryApi().issues({ query: "", status: "unresolved", period: "24h", sort: "freq", assignee: "unassigned", limit: 8 })).issues);
  const [fixing, setFixing] = createSignal<string>();
  const fix = async (issue: SentryIssue) => {
    setFixing(issue.id);
    try {
      await fixIssue(issue.id);
    } finally {
      setFixing(undefined);
    }
  };
  return (
    <Show when={data.state !== "unresolved" && data.state !== "pending"} fallback={<CardLoading />}>
      <Show when={data.state !== "errored"} fallback={<CardError message={problemOf(causeOf(data.error)).message} onRetry={() => void refetch()} />}>
        <Show when={(data.latest ?? []).length > 0} fallback={<CardEmpty icon={Bug} title={t("dash.sentry.empty")} why={t("dash.sentry.emptyWhy")} />}>
          <ul class="dash-list">
            <For each={(data.latest ?? []).slice(0, limit())}>
              {(issue) => (
                <li class="dash-row dash-row--static">
                  <Badge size="sm" tone={LEVEL_TONE[issue.level] ?? "neutral"}>
                    {issue.shortId}
                  </Badge>
                  <span class="dash-row__main">
                    <span class="dash-row__title">
                      <span class="ui-truncate" title={issue.title}>{issue.title}</span>
                    </span>
                    <span class="dash-row__sub ui-truncate ui-tnum">{t("dash.sentry.counts", { events: fmt.number(issue.count), users: fmt.number(issue.userCount) })}</span>
                  </span>
                  <Button size="sm" variant="secondary" icon={Wrench} loading={fixing() === issue.id} onClick={() => void fix(issue)} aria-label={t("dash.sentry.fixAria", { id: issue.shortId })}>
                    {t("dash.sentry.fix")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="dash-actions">
          <Button size="sm" variant="ghost" onClick={() => void openSentry()}>
            {t("dash.sentry.open")}
          </Button>
        </div>
      </Show>
    </Show>
  );
}
