import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { agentRow } from "../../store/agents";
import { repoConfig } from "../../store/workspace";
import { Badge, Button, EmptyState, FileDiff as DiffIcon, History, Save, ScrollArea, SegmentedControl, Skeleton, Undo2 } from "../../ui-kit";
import { relativeTime } from "../inspector/format";
import { checkpointsApi } from "./api";
import { errorText, newestFirst, previousStep, stepTitle, undoTarget } from "./logic";
import { checkpointsVersion, openRestore, openSavePoint } from "./store";
import type { FileDiff, RunCheckpoint } from "./types";
import "./checkpoints.css";

/** How long after a turn ends the timeline reads again: the host writes that step off the event thread. */
const AFTER_TURN_MS = 1500;

/** The checkpoints of one run, newest first: when, what, how many files changed, Compare (read-only) and Restore to this point. */
export function CheckpointTimeline(props: { runId: string }) {
  const row = () => agentRow(props.runId);
  const active = () => row()?.status === "running" || row()?.status === "needsYou";
  const [tick, setTick] = createSignal(0);
  const [steps, { refetch }] = createResource(() => [props.runId, checkpointsVersion(), tick()] as const, ([runId]) => checkpointsApi().list(runId));
  const [comparing, setComparing] = createSignal<number | undefined>(undefined);

  // a finished turn adds a step a moment later
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => row()?.status,
      (status, prev) => {
        if (prev === undefined || status === prev) return;
        clearTimeout(timer);
        timer = setTimeout(() => setTick((n) => n + 1), AFTER_TURN_MS);
      },
    ),
  );
  onCleanup(() => clearTimeout(timer));

  const undo = () => undoTarget(steps() ?? []);
  return (
    <div class="cp-timeline" data-testid="cp-timeline">
      <div class="cp-timeline__bar">
        <Button size="sm" variant="secondary" icon={Save} onClick={() => openSavePoint(props.runId)}>
          {t("checkpoints.save.button")}
        </Button>
        <span title={active() ? t("checkpoints.gate.active") : !undo() ? t("checkpoints.undo.nothing") : undefined}>
          <Button size="sm" variant="secondary" icon={Undo2} disabled={active() || !undo()} onClick={() => openRestore({ runId: props.runId, seq: undo()!.seq, mode: "undo" })}>
            {t("checkpoints.undo.button")}
          </Button>
        </span>
        <span class="cp-timeline__grow" />
        <Button size="sm" variant="ghost" onClick={() => void refetch()}>
          {t("checkpoints.timeline.refresh")}
        </Button>
      </div>
      <Show when={!steps.error} fallback={<EmptyState icon={History} size="sm" tone="danger" title={errorText(steps.error)} />}>
        <Show when={steps()} fallback={<Skeleton width="100%" height={64} />}>
          {(list) => (
            <Show when={list().length > 0} fallback={<EmptyState icon={History} size="sm" title={t("checkpoints.timeline.empty")} description={t("checkpoints.timeline.emptyDesc")} />}>
              <ScrollArea class="cp-timeline__scroll">
                <ol class="cp-timeline__list" aria-label={t("checkpoints.timeline.label")}>
                  <For each={newestFirst(list())}>
                    {(step) => (
                      <li class="cp-step" data-kind={step.kind}>
                        <div class="cp-step__top">
                          <span class="cp-step__dot" aria-hidden="true" />
                          <span class="cp-step__title ui-truncate" title={stepTitle(step)}>
                            {stepTitle(step)}
                          </span>
                          <Show when={step.kind === "save"}>
                            <Badge size="sm" tone="accent">{t("checkpoints.kind.save")}</Badge>
                          </Show>
                          <span class="cp-step__time ui-tnum" title={new Date(step.createdAt * 1000).toLocaleString()}>
                            {relativeTime(step.createdAt * 1000, Date.now())}
                          </span>
                        </div>
                        <div class="cp-step__meta">
                          <span class="ui-text-3 ui-tnum">{step.seq === 0 ? t("checkpoints.timeline.startFiles", { n: step.repos.reduce((n, r) => n + r.files, 0) }) : t("checkpoints.timeline.changed", { n: step.changed })}</span>
                          <span class="cp-timeline__grow" />
                          <Show when={step.seq > 0}>
                            <Button size="sm" variant="ghost" icon={DiffIcon} aria-expanded={comparing() === step.seq} onClick={() => setComparing((c) => (c === step.seq ? undefined : step.seq))}>
                              {t("checkpoints.timeline.compare")}
                            </Button>
                          </Show>
                          <span title={active() ? t("checkpoints.gate.active") : undefined}>
                            <Button size="sm" variant="ghost" disabled={active()} onClick={() => openRestore({ runId: props.runId, seq: step.seq, mode: "pick" })}>
                              {t("checkpoints.timeline.restore")}
                            </Button>
                          </span>
                        </div>
                        <Show when={comparing() === step.seq}>
                          <ComparePane runId={props.runId} step={step} base={previousStep(list(), step.seq)} />
                        </Show>
                      </li>
                    )}
                  </For>
                </ol>
              </ScrollArea>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}

type Range = "step" | "now";

const CHANGE_KEY = { modified: "checkpoints.compare.modified", created: "checkpoints.compare.created", deleted: "checkpoints.compare.deleted" } as const satisfies Record<FileDiff["change"], MessageKey>;

/** Read-only diff: what this step changed (from the step before), or everything since this step until now. */
function ComparePane(props: { runId: string; step: RunCheckpoint; base: RunCheckpoint | undefined }) {
  const repos = () => props.step.repos.map((r) => r.repoId);
  const [repoId, setRepoId] = createSignal(repos()[0] ?? "");
  const [range, setRange] = createSignal<Range>("step");
  const [open, setOpen] = createSignal<string | undefined>(undefined);
  const bounds = (): [number, number | null] => (range() === "step" ? [props.base?.seq ?? 0, props.step.seq] : [props.step.seq, null]);
  const [files] = createResource(() => [props.runId, repoId(), ...bounds()] as const, ([runId, repo, from, to]) => checkpointsApi().compare(runId, repo, from, to));
  const [patch] = createResource(() => (open() ? ([props.runId, repoId(), ...bounds(), open()!] as const) : undefined), ([runId, repo, from, to, path]) => checkpointsApi().patch(runId, repo, from, to, path));
  const name = (id: string) => repoConfig(id)?.name ?? id;
  return (
    <div class="cp-compare" role="region" aria-label={t("checkpoints.compare.label", { name: stepTitle(props.step) })}>
      <div class="cp-compare__bar">
        <SegmentedControl
          size="sm"
          aria-label={t("checkpoints.compare.range")}
          value={range()}
          onChange={(v) => (setRange(v as Range), setOpen(undefined))}
          options={[
            { value: "step", label: t("checkpoints.compare.step") },
            { value: "now", label: t("checkpoints.compare.now") },
          ]}
        />
        <Show when={repos().length > 1}>
          <SegmentedControl size="sm" aria-label={t("checkpoints.compare.repo")} value={repoId()} onChange={(v) => (setRepoId(v), setOpen(undefined))} options={repos().map((id) => ({ value: id, label: name(id) }))} />
        </Show>
      </div>
      <Show when={!files.error} fallback={<p class="cp-restore__error" role="alert">{errorText(files.error)}</p>}>
        <Show when={files()} fallback={<Skeleton width="100%" height={32} />}>
          {(list) => (
            <Show when={list().length > 0} fallback={<p class="ui-text-3">{t("checkpoints.compare.none")}</p>}>
              <ul class="cp-compare__files">
                <For each={list()}>
                  {(f: FileDiff) => (
                    <li>
                      <button type="button" class="cp-compare__file" data-change={f.change} aria-expanded={open() === f.path} onClick={() => setOpen((o) => (o === f.path ? undefined : f.path))}>
                        <span class="cp-restore__path ui-truncate" title={f.path}>{f.path}</span>
                        <span class="cp-compare__count ui-tnum">{f.binary ? t("checkpoints.compare.binary") : t("checkpoints.compare.lines", { add: f.additions, del: f.deletions })}</span>
                        <span class="cp-compare__change">{t(CHANGE_KEY[f.change])}</span>
                      </button>
                      <Show when={open() === f.path}>
                        <Show when={patch()} fallback={<Skeleton width="100%" height={48} />}>
                          {(text) => <pre class="cp-compare__patch ui-mono ui-selectable" tabindex="0" aria-label={t("checkpoints.compare.patch", { path: f.path })}>{text() || t("checkpoints.compare.none")}</pre>}
                        </Show>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}
