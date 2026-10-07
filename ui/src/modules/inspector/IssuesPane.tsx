import { For, Show } from "solid-js";
import { errorWording, fmtDuration } from "../../components/chat/format";
import { t } from "../../i18n";
import { Badge, CircleAlert, CircleCheck, Clock, EmptyState, Icon, TriangleAlert } from "../../ui-kit";
import { offsetLabel } from "./format";
import type { Inspection, IssueEntry } from "./model";

function IssueBody(props: { issue: IssueEntry }) {
  const wording = () => (props.issue.kind === "error" && props.issue.class ? errorWording(props.issue.class, props.issue.title) : undefined);
  return (
    <div class="insp-issue__body">
      <div class="insp-issue__title">{wording()?.title ?? props.issue.title}</div>
      <Show when={wording()}>
        <div class="insp-issue__detail">{props.issue.title}</div>
      </Show>
      <Show when={wording() && wording()!.hint !== props.issue.title}>
        <div class="insp-issue__detail">{wording()!.hint}</div>
      </Show>
      <Show when={props.issue.detail}>
        <div class="insp-issue__detail ui-truncate" title={props.issue.detail}>{props.issue.detail}</div>
      </Show>
    </div>
  );
}

export function IssuesPane(props: { inspection: Inspection }) {
  const start = () => props.inspection.startedMs ?? 0;
  return (
    <Show when={props.inspection.issues.length > 0} fallback={<EmptyState icon={CircleCheck} size="sm" title={t("inspector.issues.none")} description={t("inspector.issues.noneDesc")} />}>
      <ul class="insp-issues" aria-label={t("inspector.issues.label")}>
        <For each={props.inspection.issues}>
          {(i) => (
            <li class="insp-issue" data-kind={i.kind}>
              <Icon icon={i.kind === "throttle" ? Clock : i.kind === "error" ? CircleAlert : TriangleAlert} size={14} class="insp-issue__icon" />
              <IssueBody issue={i} />
              <span class="insp-issue__meta">
                <Show when={i.kind === "error" && i.class}>
                  <Badge size="sm" tone="danger">{i.class}</Badge>
                </Show>
                <Show when={i.kind === "error" && i.retryable}>
                  <Badge size="sm">{t("inspector.issues.retryable")}</Badge>
                </Show>
                <Show when={i.kind === "throttle" && i.untilMs !== undefined}>
                  <Badge size="sm" tone="warn" numeric>{fmtDuration(Math.max(0, (i.untilMs ?? i.atMs) - i.atMs))}</Badge>
                </Show>
                <span class="ui-tnum ui-text-3">{offsetLabel(i.atMs, start())}</span>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
