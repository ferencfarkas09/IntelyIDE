import { createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { elapsedLabel, SLOW_AFTER_MS, startingTitle } from "../../modules/runs/startingLogic";
import { requestNewRun } from "../../platform/newRun";
import { endStarting, type StartingRun } from "../../store/starting";
import { repoConfig } from "../../store/workspace";
import { Badge, Button, CircleAlert, RepoBadge, Spinner, StatusDot, TreeRow } from "../../ui-kit";

/** Milliseconds since `since`, ticking once a second for as long as the component lives. */
function useElapsed(since: () => number): () => number {
  const [now, setNow] = createSignal(Date.now());
  const id = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(id));
  return () => Math.max(0, now() - since());
}

const MAX_TASK_CHARS = 1200;

/** Hands the task back to the New run dialog, with the reason it was refused; the card goes once the dialog is open. */
async function editAndRetry(run: StartingRun): Promise<void> {
  const failure = run.failure;
  const opened = await requestNewRun({ prompt: run.retryPrompt, repoIds: run.repoIds, ...(failure ? { error: failure.message, noSafetyNet: failure.code === "noSafetyNet" } : {}) });
  if (opened) endStarting(run.key);
}

/** What fills the middle while a run is starting, or after the host refused it: the task, where it runs, how long it has been and what the wait is. */
export function StartingRunView(props: { run: StartingRun }) {
  const elapsed = useElapsed(() => props.run.startedAt);
  const task = () => (props.run.prompt.length > MAX_TASK_CHARS ? `${props.run.prompt.slice(0, MAX_TASK_CHARS)}…` : props.run.prompt);
  return (
    <section class="starting" data-testid="starting-run" data-failed={props.run.failure ? "" : undefined} aria-label={t("runs.starting.title")}>
      <Show
        when={props.run.failure}
        fallback={
          <>
            <header class="starting__head">
              <Spinner size={20} />
              <h2 class="starting__title">{t("runs.starting.title")}</h2>
              <span class="starting__elapsed ui-tnum" aria-live="off" data-testid="starting-elapsed">
                {elapsedLabel(elapsed())}
              </span>
            </header>
            <p class="starting__lead" role="status">{t("runs.starting.lead")}</p>
            <Show when={elapsed() >= SLOW_AFTER_MS}>
              <p class="starting__slow" role="note" data-testid="starting-slow">{t("runs.starting.slow")}</p>
            </Show>
          </>
        }
      >
        {(f) => (
          <>
            <header class="starting__head">
              <CircleAlert size={20} class="starting__alert" />
              <h2 class="starting__title">{t("runs.starting.failedTitle")}</h2>
            </header>
            <p class="starting__error" role="alert">{f().message}</p>
            <div class="starting__actions">
              <Button variant="primary" onClick={() => void editAndRetry(props.run)}>
                {t("runs.starting.retry")}
              </Button>
              <Button variant="ghost" onClick={() => endStarting(props.run.key)}>
                {t("runs.starting.dismiss")}
              </Button>
            </div>
          </>
        )}
      </Show>
      <div class="starting__block">
        <span class="starting__label">{t("runs.starting.task")}</span>
        <pre class="starting__task">{task()}</pre>
      </div>
      <Show when={props.run.repoIds.length > 0}>
        <div class="starting__block">
          <span class="starting__label">{t("runs.starting.repos")}</span>
          <ul class="starting__repos">
            <For each={props.run.repoIds}>
              {(id) => (
                <li>
                  <Show when={repoConfig(id)} fallback={<Badge size="sm">{id}</Badge>}>
                    {(c) => (
                      <>
                        <RepoBadge color={c().color} badge={c().badge} size={16} title={c().name} /> {c().name}
                      </>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </section>
  );
}

const rowLabel = (run: StartingRun) => (run.failure ? t("runs.starting.failedTitle") : t("runs.starting.row"));

/** A run that is starting, as a card of the sessions sidebar (Agent workspace). */
export function StartingCard(props: { run: StartingRun; selected: boolean; onSelect: () => void }) {
  const elapsed = useElapsed(() => props.run.startedAt);
  const failed = () => props.run.failure !== undefined;
  return (
    <button type="button" class="run-card" data-selected={props.selected ? "" : undefined} data-status={failed() ? "error" : "running"} data-starting="" aria-current={props.selected ? "true" : undefined} title={startingTitle(props.run.prompt, 200)} onClick={props.onSelect}>
      <span class="run-card__top">
        <StatusDot tone={failed() ? "danger" : "accent"} label={rowLabel(props.run)} pulse={!failed()} />
        <span class="run-card__title ui-truncate">{startingTitle(props.run.prompt)}</span>
        <Show when={!failed()}>
          <span class="run-card__ago ui-tnum">{elapsedLabel(elapsed())}</span>
        </Show>
      </span>
      <span class="run-card__activity ui-truncate" data-attention={failed() ? "" : undefined}>
        {failed() ? props.run.failure!.message : t("runs.starting.activity")}
      </span>
    </button>
  );
}

/** The same, as a row of the dock's list of runs (editor mode). */
export function StartingTreeRow(props: { run: StartingRun; selected: boolean; onSelect: () => void }) {
  const elapsed = useElapsed(() => props.run.startedAt);
  const failed = () => props.run.failure !== undefined;
  return (
    <TreeRow
      selected={props.selected}
      leading={<StatusDot tone={failed() ? "danger" : "accent"} label={rowLabel(props.run)} pulse={!failed()} />}
      trailing={<span class="runs__meta ui-tnum">{failed() ? t("runs.starting.failedTitle") : elapsedLabel(elapsed())}</span>}
      onClick={props.onSelect}
      onKeyDown={(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onSelect())}
      tabbable
      class="runs__row"
      title={startingTitle(props.run.prompt, 200)}
    >
      <span class="ui-truncate">{startingTitle(props.run.prompt)}</span>
    </TreeRow>
  );
}
