import { createSignal, createUniqueId, For, Show } from "solid-js";
import { locale, t } from "../../i18n";
import { requestNewRun } from "../../platform/newRun";
import { openSettings } from "../../platform/settings";
import type { AgentRow } from "../../store/agents";
import { repoConfig } from "../../store/workspace";
import { Button, ChevronDown, ChevronRight, CircleCheck, CircleX, Clock, Icon, ListChecks, readStored, RotateCw, Spinner, toast, TriangleAlert, Wrench, writeStored } from "../../ui-kit";
import { buildFixPrompt, canRunTests } from "./flow";
import { autotestFlow, currentRuns } from "./instance";
import { MAX_FAILURES } from "./logic";
import { prefs, runAsk, runResults } from "./store";
import type { RepoTest } from "./types";
import "./autotest.css";

const nameOf = (repoId: string): string => repoConfig(repoId)?.name ?? repoId;

/** The results card's fold, remembered like the run summary's; the actions stay on screen when it is folded. */
const COLLAPSED_KEY = "intely.autotest.collapsed";

function formatDuration(ms: number): string {
  if (ms < 1000) return t("autotest.unit.ms", { n: Math.max(0, Math.round(ms)) });
  const s = ms / 1000;
  return t("autotest.unit.s", { n: new Intl.NumberFormat(locale(), { maximumFractionDigits: s < 10 ? 1 : 0 }).format(s) });
}

function statusLine(r: RepoTest): string {
  const s = r.summary;
  switch (r.status) {
    case "waiting":
      return t("autotest.status.waiting");
    case "running":
      return t("autotest.status.running", { runner: r.runner ?? "" });
    case "noTests":
      return t("autotest.status.noTests");
    case "timeout":
      return t("autotest.status.timeout", { min: 5 });
    case "error":
      return t("autotest.status.error");
    case "passed":
      return s?.matched ? t("autotest.status.passedCount", { n: s.passed }) : t("autotest.status.passed");
    case "failed":
      return s?.matched && s.failed > 0 ? t("autotest.status.failedCount", { n: s.failed }) : t("autotest.status.failed");
  }
}

const ICON = { waiting: Clock, running: Clock, noTests: ListChecks, timeout: TriangleAlert, error: TriangleAlert, passed: CircleCheck, failed: CircleX } as const;

function RepoResult(props: { test: RepoTest; many: boolean }) {
  const r = () => props.test;
  const s = () => r().summary;
  const extra = () => Math.max(0, (s()?.failed ?? 0) - (s()?.failures.length ?? 0));
  return (
    <li class="autotest-card__repo" data-status={r().status}>
      <div class="autotest-card__line">
        <Show when={r().status === "running"} fallback={<Icon icon={ICON[r().status]} size={14} class="autotest-card__icon" />}>
          <Spinner size={14} />
        </Show>
        <Show when={props.many}>
          <span class="autotest-card__name">{nameOf(r().repoId)}</span>
        </Show>
        <span>{statusLine(r())}</span>
        <Show when={s()?.matched && (r().status === "passed" || r().status === "failed")}>
          <span class="ui-text-3 ui-tnum">{t("autotest.card.counts", { passed: s()!.passed, failed: s()!.failed, skipped: s()!.skipped })}</span>
        </Show>
        <Show when={s()?.durationMs !== undefined && r().status !== "running"}>
          <span class="ui-text-3 ui-tnum">{formatDuration(s()!.durationMs!)}</span>
        </Show>
      </div>
      <Show when={r().runner && r().status !== "noTests"}>
        <div class="autotest-card__runner ui-mono ui-text-3">{r().runner}</div>
      </Show>
      <Show when={r().error}>
        <div class="autotest-card__error ui-selectable">{r().error}</div>
      </Show>
      <Show when={(s()?.failures.length ?? 0) > 0 && r().status !== "passed"}>
        <ul class="autotest-card__failures ui-selectable" aria-label={t("autotest.card.failures")}>
          <For each={s()!.failures.slice(0, MAX_FAILURES)}>
            {(f) => (
              <li>
                <span class="autotest-card__test ui-mono">{f.name}</span>
                <Show when={f.message}>
                  <span class="autotest-card__msg">{f.message}</span>
                </Show>
              </li>
            )}
          </For>
          <Show when={extra() > 0}>
            <li class="ui-text-3">{t("autotest.card.more", { n: extra() })}</li>
          </Show>
        </ul>
      </Show>
    </li>
  );
}

/** "Run the unit tests after each run?": shown once per repository in Ask mode; the answer is remembered. */
function AskCard(props: { agent: AgentRow; repoIds: string[] }) {
  const names = () => props.repoIds.map(nameOf).join(", ");
  return (
    <section class="autotest-card autotest-card--ask" aria-label={t("autotest.ask.title")}>
      <div class="autotest-card__head">
        <Icon icon={ListChecks} size={14} class="autotest-card__icon" />
        <strong>{t("autotest.ask.title")}</strong>
      </div>
      <p class="autotest-card__body">{t("autotest.ask.body", { repos: names(), n: props.repoIds.length })}</p>
      <div class="autotest-card__actions">
        <Button size="sm" variant="primary" onClick={() => void autotestFlow().answer(props.agent.agentId, "yes")}>
          {t("autotest.ask.yes")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void autotestFlow().answer(props.agent.agentId, "no")}>
          {t("autotest.ask.no")}
        </Button>
        <Button size="sm" variant="ghost" class="autotest-card__settings" onClick={() => openSettings("autotest")}>
          {t("autotest.ask.settings")}
        </Button>
      </div>
      <p class="autotest-card__note ui-text-3">{t("autotest.ask.note")}</p>
    </section>
  );
}

function ResultCard(props: { agent: AgentRow; results: RepoTest[] }) {
  const failed = () => props.results.filter((r) => r.status === "failed");
  const canRun = () => canRunTests(currentRuns(), props.agent.agentId, props.agent.repoIds);
  const rerun = () => void autotestFlow().runTests(props.agent.agentId, props.agent.repoIds);
  const fix = async () => {
    const tests = failed();
    const prompt = buildFixPrompt(tests, nameOf);
    const opened = await requestNewRun({ prompt, repoIds: tests.map((r) => r.repoId) });
    if (!opened) toast.error(t("autotest.toast.fixFailed"));
  };
  const [open, setOpen] = createSignal(readStored(COLLAPSED_KEY) !== "1");
  const toggle = () => {
    const next = !open();
    setOpen(next);
    writeStored(COLLAPSED_KEY, next ? "0" : "1");
  };
  const listId = createUniqueId();
  return (
    <section class="autotest-card" aria-label={t("autotest.card.title")} aria-live="polite">
      <div class="autotest-card__head">
        <Button class="autotest-card__toggle" variant="ghost" size="sm" icon={open() ? ChevronDown : ChevronRight} aria-expanded={open()} aria-controls={listId} onClick={toggle}>
          {t("autotest.card.title")}
        </Button>
      </div>
      <Show when={open()}>
        <ul class="autotest-card__repos" id={listId}>
          <For each={props.results}>{(r) => <RepoResult test={r} many={props.agent.repoIds.length > 1} />}</For>
        </ul>
      </Show>
      <div class="autotest-card__actions">
        <Show when={failed().length > 0}>
          <Button size="sm" variant="primary" icon={Wrench} onClick={() => void fix()} title={t("autotest.card.fixTip")}>
            {t("autotest.card.fix")}
          </Button>
        </Show>
        <Button size="sm" variant="secondary" icon={RotateCw} disabled={!canRun()} title={canRun() ? undefined : t("autotest.header.busyTip")} onClick={rerun}>
          {t("autotest.card.rerun")}
        </Button>
      </div>
    </section>
  );
}

/** The cards at the top of a run's page: the open question, then the results. */
export default function AutotestTop(props: { agent: AgentRow }) {
  const ask = () => (prefs().mode === "ask" ? runAsk(props.agent.agentId) : []);
  const order = (id: string) => {
    const i = props.agent.repoIds.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const results = () => runResults(props.agent.agentId).sort((x, y) => order(x.repoId) - order(y.repoId));
  return (
    <>
      <Show when={ask().length > 0}>
        <AskCard agent={props.agent} repoIds={ask()} />
      </Show>
      <Show when={results().length > 0}>
        <ResultCard agent={props.agent} results={results()} />
      </Show>
    </>
  );
}
