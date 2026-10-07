import { createSignal, createUniqueId, Show } from "solid-js";
import type { PermissionItem } from "../../store/agent-reducer";
import type { AnswerExtra } from "../../store/agents";
import type { McpExposure, PermissionDecision, PermissionMode } from "../../store/agent-types";
import { Badge, Ban, Button, Icon, ListChecks, ShieldCheck, TextArea } from "../../ui-kit";
import { t } from "../../i18n";
import { focusRequest, refocusAfterAnswer } from "./Cards";
import { Markdown } from "./Markdown";
import { ModeCards } from "./ModeCards";
import { AFTER_PLAN, exposureOf, MODE_META, modeErrorText } from "./modes";
import "./modes.css";

/**
 * The approval card of ExitPlanMode: the full plan, the mode to continue in (Ask, Accept edits or Automatic, never Bypass) and two
 * answers, Approve and Request changes. Approving moves the run out of Plan; rejecting keeps Plan and sends the note to the model.
 */
export function PlanApprovalCard(props: { item: PermissionItem; onAnswer: (decision: PermissionDecision, extra?: AnswerExtra) => void; /** The run's MCP servers: what they would run unasked in Automatic. */ mcp?: readonly McpExposure[] }) {
  let card: HTMLElement | undefined;
  const uid = createUniqueId();
  const modes = (): PermissionMode[] => {
    const offered = (props.item.modes?.length ? props.item.modes : [...AFTER_PLAN]).filter((m) => AFTER_PLAN.includes(m));
    return offered.length ? offered : [...AFTER_PLAN];
  };
  // Ask unless the run came from Accept edits; Automatic is never the default, whatever was used last: it needs its own click.
  const initial = (): PermissionMode => {
    const wanted: PermissionMode = props.item.prePlanMode === "edit" ? "edit" : "ask";
    return modes().includes(wanted) ? wanted : modes()[0];
  };
  // State lives outside the pending/resolved switch: a refused answer puts the card back with the typed note and the pick intact.
  const [picked, setPicked] = createSignal<PermissionMode | undefined>(undefined);
  const mode = () => picked() ?? initial();
  const [revising, setRevising] = createSignal(false);
  const [note, setNote] = createSignal("");
  const exposure = () => exposureOf(props.mcp);

  const send = (decision: PermissionDecision, extra?: AnswerExtra) => {
    refocusAfterAnswer(card);
    props.onAnswer(decision, extra);
  };
  const sendFeedback = () => {
    if (note().trim()) send("deny", { feedback: note().trim() });
  };
  const planText = () => (
    <Show when={props.item.plan}>
      {(text) => (
        <div class="plan-approval__text" tabindex="0" role="region" aria-label={t("modes.plan.title")}>
          <Markdown text={text()} />
        </div>
      )}
    </Show>
  );

  return (
    <Show
      when={!props.item.outcome}
      fallback={
        <div class="plan-approval__done" data-outcome={props.item.outcome} role="status">
          <div class="plan-approval__done-row">
            <Icon icon={props.item.outcome === "allow" ? ShieldCheck : Ban} size={14} />
            <span>
              {props.item.outcome === "allow"
                ? props.item.mode
                  ? t("modes.plan.approved", { mode: t(MODE_META[props.item.mode].label) })
                  : t("modes.plan.approvedPlain")
                : props.item.feedback
                  ? t("modes.plan.rejected", { note: props.item.feedback })
                  : t("modes.plan.rejectedNoNote")}
            </span>
          </div>
          <Show when={props.item.plan}>
            <details class="plan-approval__show">
              <summary>{t("modes.plan.show")}</summary>
              {planText()}
            </details>
          </Show>
        </div>
      }
    >
      <section
        ref={(el) => {
          card = el;
          requestAnimationFrame(() => focusRequest(props.item.reqId, el));
        }}
        class="perm plan-approval"
        role="group"
        aria-label={t("modes.plan.aria")}
        data-testid="plan-approval"
      >
        <header class="perm__head">
          <Icon icon={ListChecks} size={14} />
          <span class="perm__title">{t("modes.plan.title")}</span>
          <Badge size="sm">{t(MODE_META.readOnly.label)}</Badge>
        </header>
        <Show when={props.item.plan} fallback={<p class="plan-approval__notice">{t("modes.plan.noText")}</p>}>
          {planText()}
          <Show when={props.item.planTruncated}>
            <p class="plan-approval__notice">{t("modes.plan.truncated")}</p>
          </Show>
        </Show>
        <fieldset class="plan-approval__modes">
          <legend class="plan-approval__legend" id={`${uid}-legend`}>
            {t("modes.plan.continueIn")}
          </legend>
          <ModeCards modes={modes()} value={mode()} onChange={setPicked} labelledBy={`${uid}-legend`} layout="list" />
          <Show when={mode() === "automatic"}>
            <p class="plan-approval__notice" role="status" data-testid="plan-unattended">
              {t("modes.plan.unattendedNote")}
              <Show when={exposure().count > 0}>{` ${t("modes.exposure.line", { count: exposure().count, names: exposure().names })}`}</Show>
              <Show when={exposure().secretNames}>{` ${t("modes.exposure.secretEnv", { names: exposure().secretNames })}`}</Show>
            </p>
          </Show>
        </fieldset>
        <Show
          when={revising()}
          fallback={
            <div class="perm__actions">
              <Button size="sm" variant="primary" data-primary onClick={() => send("allowOnce", { mode: mode() })}>
                {t("modes.plan.approve")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setRevising(true)}>
                {t("modes.plan.requestChanges")}
              </Button>
            </div>
          }
        >
          <div class="plan-approval__feedback">
            <label class="plan-approval__legend" for={`${uid}-note`}>
              {t("modes.plan.feedbackLabel")}
            </label>
            <TextArea
              id={`${uid}-note`}
              ref={(el: HTMLTextAreaElement) => queueMicrotask(() => el.focus({ preventScroll: true }))}
              minRows={2}
              maxRows={8}
              placeholder={t("modes.plan.placeholder")}
              value={note()}
              onInput={(e) => setNote(e.currentTarget.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && (e.preventDefault(), sendFeedback())}
            />
            <div class="perm__actions">
              <Button size="sm" variant="primary" disabled={!note().trim()} onClick={sendFeedback}>
                {t("modes.plan.sendFeedback")}
              </Button>
              <Show when={!note().trim()}>
                <Button size="sm" variant="secondary" onClick={() => send("deny")}>
                  {t("modes.plan.rejectNoNote")}
                </Button>
              </Show>
              <Button size="sm" variant="ghost" onClick={() => setRevising(false)}>
                {t("modes.plan.back")}
              </Button>
            </div>
          </div>
        </Show>
        <Show when={props.item.error}>{(e) => <p class="perm__error" role="alert">{modeErrorText(e().code, e().message)}</p>}</Show>
      </section>
    </Show>
  );
}
