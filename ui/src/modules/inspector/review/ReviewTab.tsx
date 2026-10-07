import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import type { TabInstance } from "../../../platform/tabs";
import { agentRow, agentView, startRun } from "../../../store/agents";
import { deriveTick } from "../../../store/selection-model";
import { setSelectedFile } from "../../../store/selection";
import { refreshSnapshots, snapshots } from "../../../store/snapshots";
import { dismissTouched } from "../../../store/touched";
import { repoConfig } from "../../../store/workspace";
import { Badge, Button, Checkbox, CircleAlert, CircleCheck, EmptyState, FileDiff, IconButton, ListChecks, RepoBadge, SegmentedControl, Skeleton, Sparkles, Spinner, toast } from "../../../ui-kit";
import { openInspector } from "../openers";
import { asRunParams, useInspection } from "../useInspection";
import { applyReverts, canRevert, decisionOf, reviewFilesOf, revertCount, type ReviewFile } from "./files";
import { findingsForFile, parseFindings, reviewerPrompt, SEVERITY_TONE, type Finding } from "./findings";
import { hunkHeader, hunkText, type Decision, type Hunk } from "./hunks";
import { reviewState, setApplied, setDecisions, setReviewer } from "./reviewState";
import "./review.css";

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const message = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));

export default function ReviewTab(props: { tab: TabInstance }) {
  const params = () => asRunParams(props.tab.params);
  const { log, inspection } = useInspection(params);
  const runId = () => params().runId;
  const state = () => reviewState(runId());
  const files = createMemo(() => reviewFilesOf(inspection()));
  const hunkCount = () => files().reduce((n, f) => n + f.hunks.length, 0);
  const reverts = () => revertCount(files(), state().decisions);
  const [applying, setApplying] = createSignal(false);
  const [starting, setStarting] = createSignal(false);

  const reviewer = () => (state().reviewerId ? agentRow(state().reviewerId!) : undefined);
  const answer = () =>
    (state().reviewerId ? agentView(state().reviewerId!)?.items : undefined)
      ?.filter((i) => i.type === "text")
      .map((i) => (i as { text: string }).text)
      .join("\n") ?? "";
  const findings = createMemo(() => parseFindings(answer()));
  const reviewerDone = () => reviewer()?.status === "done" || reviewer()?.status === "error";

  const decideAll = (d: Decision) => setDecisions(runId(), files().filter((f) => d === "keep" || canRevert(f)).flatMap((f) => f.hunks.map((h) => h.id)), d);

  async function runReviewer() {
    setStarting(true);
    try {
      const diff = files().map((f) => `--- ${f.repoId}/${f.path}\n${f.hunks.map(hunkText).join("\n")}`).join("\n\n");
      const repoIds = [...new Set(files().map((f) => f.repoId))];
      const summary = await startRun({ role: "reviewer", repoIds, prompt: reviewerPrompt(params().title ?? inspection().title ?? runId(), diff) });
      setReviewer(runId(), summary.agentId);
    } catch (e) {
      toast.error(t("inspector.review.startFail"), message(e));
    } finally {
      setStarting(false);
    }
  }

  async function apply() {
    setApplying(true);
    const results = await applyReverts(files(), state().decisions, ipc);
    setApplied(runId(), results);
    const failed = results.filter((r) => r.status === "failed");
    const done = results.filter((r) => r.status === "reverted");
    if (done.length) toast.success(t("inspector.review.revertedToast", { n: done.length }));
    if (failed.length) toast.error(t("inspector.review.notChanged", { n: failed.length }), failed[0].message);
    dismissTouched(files().filter((f) => !failed.some((r) => r.repoId === f.repoId && r.path === f.path)).map((f) => ({ repoId: f.repoId, path: f.path })));
    void refreshSnapshots(null);
    setApplying(false);
  }

  return (
    <section class="rev" aria-label={t("inspector.review.label")}>
      <Switch>
        <Match when={!log() || log()!.status === "loading"}>
          <div class="rev__loading" aria-busy="true">
            <Skeleton width="50%" height={18} />
            <Skeleton width="100%" height={120} />
          </div>
        </Match>
        <Match when={log()!.status !== "ready"}>
          <EmptyState icon={CircleAlert} title={t("inspector.review.cannot")} description={log()!.status === "expired" ? t("inspector.review.expiredDesc") : log()!.error} />
        </Match>
        <Match when={files().length === 0}>
          <EmptyState icon={ListChecks} title={t("inspector.review.nothing")} description={t("inspector.review.nothingDesc")} action={<Button onClick={() => openInspector(params())}>{t("inspector.review.openInspector")}</Button>} />
        </Match>
        <Match when={true}>
          <header class="rev__head">
            <div class="rev__title">
              <h2 class="ui-truncate">{t("inspector.tab.review", { title: params().title ?? inspection().title ?? runId() })}</h2>
              <span class="ui-text-3 ui-tnum">
                {t("inspector.review.summary", { files: files().length, hunks: hunkCount(), reverts: reverts() })}
              </span>
            </div>
            <div class="rev__actions">
              <Button size="sm" variant="ghost" onClick={() => decideAll("keep")}>{t("inspector.review.keepAll")}</Button>
              <Button size="sm" variant="ghost" onClick={() => decideAll("revert")}>{t("inspector.review.revertAll")}</Button>
              <Button size="sm" icon={Sparkles} loading={starting() || reviewer()?.status === "running"} onClick={() => void runReviewer()}>
                {state().reviewerId ? t("inspector.review.runAgain") : t("inspector.review.runAgent")}
              </Button>
              <Button size="sm" variant="danger" disabled={reverts() === 0} loading={applying()} onClick={() => void apply()}>
                {reverts() > 0 ? t("inspector.review.applyN", { n: reverts() }) : t("inspector.review.apply")}
              </Button>
            </div>
          </header>
          <div class="rev__body">
            <Show when={state().reviewerId}>
              <FindingsPanel findings={findings()} running={!reviewerDone()} answer={answer()} />
            </Show>
            <Show when={state().applied.length > 0}>
              <ul class="rev__applied" aria-label={t("inspector.review.applyResult")}>
                <For each={state().applied}>
                  {(r) => (
                    <li data-status={r.status}>
                      {r.status === "reverted" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
                      <span class="ui-truncate">{r.path}</span>
                      <span class="ui-text-3">{r.status === "reverted" ? t("inspector.review.revertedStatus") : r.message}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <For each={files()}>{(f) => <FileCard runId={runId()} file={f} findings={findingsForFile(findings(), f.path)} />}</For>
          </div>
        </Match>
      </Switch>
    </section>
  );
}

function FindingsPanel(props: { findings: Finding[]; running: boolean; answer: string }) {
  return (
    <section class="rev-findings" aria-label={t("inspector.review.findings")} aria-live="polite">
      <h3>
        {t("inspector.review.reviewer")}
        <Show when={props.running} fallback={<Badge size="sm" numeric tone={props.findings.length ? "warn" : "ok"}>{props.findings.length}</Badge>}>
          <Spinner size={12} label={t("inspector.review.reviewing")} />
        </Show>
      </h3>
      <Show when={!props.running}>
        <Show when={props.findings.length > 0} fallback={<p class="ui-text-3 rev-findings__none">{props.answer.trim() ? t("inspector.review.noStructured") : t("inspector.review.noAnswer")}<br />{props.answer.trim().slice(0, 600)}</p>}>
          <ul class="rev-findings__list">
            <For each={props.findings}>
              {(f) => (
                <li>
                  <Badge size="sm" tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                  <span class="rev-findings__where ui-truncate" title={f.path}>{nameOf(f.path)}{f.line ? `:${f.line}` : ""}</span>
                  <span class="rev-findings__msg">{f.message}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

function FileCard(props: { runId: string; file: ReviewFile; findings: Finding[] }) {
  const f = () => props.file;
  const decisions = () => reviewState(props.runId).decisions;
  const keptCount = () => f().hunks.filter((h) => decisionOf(decisions(), h) === "keep").length;
  const tick = () => deriveTick(keptCount(), f().hunks.length);
  const adds = () => f().hunks.reduce((n, h) => n + h.adds, 0);
  const dels = () => f().hunks.reduce((n, h) => n + h.dels, 0);
  const inHunk = (n: Finding) => f().hunks.some((h) => n.line !== undefined && h.lines.some((l) => l.new === n.line));
  const stillChanged = () => !!snapshots()[f().repoId]?.changes.some((c) => c.path === f().path);
  return (
    <article class="rev-file" id={`rev-${f().repoId}-${f().path}`}>
      <header class="rev-file__head">
        <Checkbox
          size="sm"
          aria-label={t("inspector.review.keepFile", { name: nameOf(f().path) })}
          checked={tick() === "checked" ? true : tick() === "mixed" ? "mixed" : false}
          disabled={!canRevert(f())}
          onChange={() => setDecisions(props.runId, f().hunks.map((h) => h.id), tick() === "checked" ? "revert" : "keep")}
        />
        <Show when={repoConfig(f().repoId)} fallback={<Badge size="sm">{f().repoId}</Badge>}>
          {(r) => <RepoBadge color={r().color} badge={r().badge} size={16} title={r().name} />}
        </Show>
        <span class="rev-file__path ui-truncate" title={f().path}>
          {nameOf(f().path)}
          <span class="ui-path-hint">{f().path.includes("/") ? f().path.slice(0, f().path.lastIndexOf("/")) : ""}</span>
        </span>
        <Show when={f().created}>
          <Badge tone="ok" size="sm" title={t("inspector.review.newTip")}>{t("inspector.files.new")}</Badge>
        </Show>
        <Show when={f().deleted}>
          <Badge tone="danger" size="sm" title={t("inspector.review.deletedTip")}>{t("inspector.files.deleted")}</Badge>
        </Show>
        <span class="rev-file__delta ui-tnum"><span class="insp-add">+{adds()}</span> <span class="insp-del">−{dels()}</span></span>
        <IconButton icon={FileDiff} size="sm" label={t("inspector.files.openDiff", { name: nameOf(f().path) })} tooltip={stillChanged() ? t("inspector.files.openTip") : t("inspector.review.goneTip")} disabled={!stillChanged()} onClick={() => setSelectedFile(f().repoId, f().path)} />
      </header>
      <For each={props.findings.filter((n) => !inHunk(n))}>
        {(n) => (
          <div class="rev-note" data-severity={n.severity} role="note">
            <Badge size="sm" tone={SEVERITY_TONE[n.severity]}>{n.severity}</Badge> {n.line ? <span class="ui-text-3">{t("inspector.review.lineNote", { n: n.line })}{" "}</span> : null}{n.message}
          </div>
        )}
      </For>
      <Show when={f().hunks.length === 0}>
        <p class="rev-file__empty ui-text-3">{t("inspector.review.deletedEmpty")}</p>
      </Show>
      <For each={f().hunks}>{(h) => <HunkView runId={props.runId} file={f()} hunk={h} findings={props.findings} />}</For>
    </article>
  );
}

function HunkView(props: { runId: string; file: ReviewFile; hunk: Hunk; findings: Finding[] }) {
  const decision = () => decisionOf(reviewState(props.runId).decisions, props.hunk);
  return (
    <div class="rev-hunk" data-decision={decision()}>
      <div class="rev-hunk__bar">
        <code class="rev-hunk__header">{hunkHeader(props.hunk)}</code>
        <SegmentedControl<Decision>
          size="sm"
          aria-label={t("inspector.review.hunkAt", { n: props.hunk.newStart })}
          value={decision()}
          onChange={(d) => setDecisions(props.runId, [props.hunk.id], d)}
          options={[
            { value: "keep", label: t("inspector.review.keep") },
            { value: "revert", label: t("inspector.review.revert"), disabled: !canRevert(props.file), tooltip: canRevert(props.file) ? undefined : t("inspector.review.revertNotAllowed") },
          ]}
        />
      </div>
      <div class="rev-lines" role="group" aria-label={t("inspector.review.changedLines")}>
        <For each={props.hunk.lines}>
          {(l) => (
            <>
              <div class="rev-line" data-kind={l.kind}>
                <span class="rev-line__no ui-tnum">{l.old ?? ""}</span>
                <span class="rev-line__no ui-tnum">{l.new ?? ""}</span>
                <span class="rev-line__sign" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                <code class="rev-line__text">{l.text || " "}</code>
              </div>
              <For each={l.new === undefined ? [] : props.findings.filter((n) => n.line === l.new)}>
                {(n) => (
                  <div class="rev-note rev-note--inline" data-severity={n.severity} role="note">
                    <Badge size="sm" tone={SEVERITY_TONE[n.severity]}>{n.severity}</Badge> {n.message}
                  </div>
                )}
              </For>
            </>
          )}
        </For>
      </div>
    </div>
  );
}
