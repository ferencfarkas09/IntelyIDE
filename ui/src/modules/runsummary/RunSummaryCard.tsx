import { createEffect, createResource, createSignal, createUniqueId, For, Show } from "solid-js";
import { t } from "../../i18n";
import { requestNewRun } from "../../platform/newRun";
import type { AgentRow } from "../../store/agents";
import { Badge, Button, ChevronDown, ChevronRight, Icon, ListChecks, readStored, Sparkles, toast, TriangleAlert, writeStored } from "../../ui-kit";
import { runSummaryApi } from "./api";
import { bullets, checkLines, chipText, explainPrompt, isFinished, riskLines, scriptRepos } from "./logic";
import { clearShow, ensureDigest, entryOf, shown } from "./store";
import type { ScriptHint } from "./types";
import "./runsummary.css";

const COLLAPSED_KEY = "intely.runSummary.collapsed";

/** "What this run did", at the top of a finished run's page: plain sentences, what to check, risks. No model. */
export default function RunSummaryCard(props: { agent: AgentRow }) {
  const finished = () => isFinished(props.agent.status);
  createEffect(() => {
    if (finished()) void ensureDigest(props.agent.agentId, props.agent.status);
  });
  const digest = () => (finished() ? (entryOf(props.agent.agentId)?.digest ?? undefined) : undefined);

  const [open, setOpen] = createSignal(readStored(COLLAPSED_KEY) !== "1");
  const toggle = () => {
    const next = !open();
    setOpen(next);
    writeStored(COLLAPSED_KEY, next ? "0" : "1");
  };

  // The dev, start and test scripts of the repositories a check names (names only, from the run catalog).
  const [scripts] = createResource(
    () => {
      const d = digest();
      const ids = d ? scriptRepos(d) : [];
      return ids.length ? ids.join("\n") : false;
    },
    async (key) => {
      const out: Record<string, ScriptHint[]> = {};
      await Promise.all(
        key.split("\n").map(async (id) => {
          try {
            out[id] = await runSummaryApi().scripts(id);
          } catch {
            /* no catalog for this repository: the generic sentence is used */
          }
        }),
      );
      return out;
    },
  );

  let root: HTMLElement | undefined;
  createEffect(() => {
    const req = shown();
    if (!req || req.runId !== props.agent.agentId || !digest()) return;
    clearShow();
    setOpen(true);
    queueMicrotask(() => {
      root?.scrollIntoView?.({ block: "nearest" });
      root?.querySelector<HTMLButtonElement>(".runsummary__toggle")?.focus();
    });
  });

  const explain = async () => {
    const d = digest();
    if (!d) return;
    const opened = await requestNewRun({ prompt: explainPrompt(d), repoIds: props.agent.repoIds });
    if (!opened) toast.error(t("runsummary.card.explainFailed"));
  };

  const bodyId = createUniqueId();
  const titleId = createUniqueId();
  return (
    <Show when={digest()}>
      {(d) => (
        <section class="runsummary" ref={root} aria-labelledby={titleId} data-testid="runsummary-card">
          <div class="runsummary__head">
            <Button class="runsummary__toggle" variant="ghost" size="sm" icon={open() ? ChevronDown : ChevronRight} aria-expanded={open()} aria-controls={bodyId} onClick={toggle}>
              <span id={titleId}>{t("runsummary.card.title")}</span>
            </Button>
            <Badge size="sm" numeric tone={d().risks.length ? "warn" : "neutral"}>
              {chipText(d())}
            </Badge>
            <span class="runsummary__grow" />
            <Button variant="secondary" size="sm" icon={Sparkles} title={t("runsummary.card.explainTip")} onClick={() => void explain()}>
              {t("runsummary.card.explain")}
            </Button>
          </div>
          <Show when={open()}>
            <div class="runsummary__body" id={bodyId}>
              <ul class="runsummary__list">
                <For each={bullets(d())}>{(b) => <li>{b}</li>}</For>
              </ul>
              <Show when={checkLines(d(), scripts() ?? {}).length}>
                <h4 class="runsummary__sub">
                  <Icon icon={ListChecks} size={14} />
                  {t("runsummary.card.check")}
                </h4>
                <ul class="runsummary__list">
                  <For each={checkLines(d(), scripts() ?? {})}>{(line) => <li>{line}</li>}</For>
                </ul>
              </Show>
              <Show when={d().risks.length}>
                <h4 class="runsummary__sub" data-tone="warn">
                  <Icon icon={TriangleAlert} size={14} />
                  {t("runsummary.card.risks")}
                </h4>
                <ul class="runsummary__list runsummary__risks">
                  <For each={riskLines(d())}>{(r) => <li data-code={r.code}>{r.text}</li>}</For>
                </ul>
              </Show>
              <Show when={d().truncated}>
                <p class="runsummary__note">{t("runsummary.card.truncated")}</p>
              </Show>
              <p class="runsummary__note">{t("runsummary.card.source")}</p>
            </div>
          </Show>
        </section>
      )}
    </Show>
  );
}
