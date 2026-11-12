import { createMemo, createSignal, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { modelLabel } from "../../components/chat/format";
import type { AgentRow } from "../../store/agents";
import { Button, IconButton, Popover, toast, X } from "../../ui-kit";
import { buildCockpit } from "../history/cockpit";
import { loadRunLog, runLog } from "../inspector/runEvents";
import { canCompact, compact, compactBusy, continueFresh } from "./actions";
import { contextHistory, contextMeter, ringDash, shortTokens, turnsLeft, type Meter } from "./meter";
import "./tokensaver.css";

const failed = (key: "tokensaver.fail.compact" | "tokensaver.fail.fresh") => (e: unknown) => toast.error(t(key), (e as { message?: string })?.message ?? String(e));

/** "about 14 turns left", or undefined when no pace can be named. */
const paceText = (left: number | undefined): string | undefined => (left === undefined ? undefined : t("ctxmeter.paceValue", { n: left }));

/** What "Copy summary" puts on the clipboard: the numbers of the popover as plain text, nothing from the conversation. */
export function summaryText(meter: Meter, model: string, left: number | undefined): string {
  const lines = [
    t("ctxmeter.title"),
    t("ctxmeter.summary.used", { used: shortTokens(meter.used), size: shortTokens(meter.size), percent: meter.percent }),
    `${t("ctxmeter.model")}: ${t("ctxmeter.modelValue", { model: modelLabel(model), size: shortTokens(meter.size) })}`,
  ];
  const pace = paceText(left);
  if (pace) lines.push(`${t("ctxmeter.pace")}: ${pace}`);
  lines.push(t("ctxmeter.summary.source"));
  return lines.join("\n");
}

/** The ring's arc and track; decorative, the button carries the name. */
function Ring(props: { fraction: number }) {
  return (
    <svg class="ctxm-ring__svg" aria-hidden="true" width="18" height="18" viewBox="0 0 36 36">
      <circle class="ctxm-ring__track" cx="18" cy="18" r="14" fill="none" stroke-width="5" />
      <circle class="ctxm-ring__arc" cx="18" cy="18" r="14" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray={ringDash(props.fraction)} />
    </svg>
  );
}

/** The popover of the ring: the numbers, what they mean, and what to do about a full context. */
export function ContextMeterPanel(props: { agent: AgentRow; meter: Meter; close: () => void }) {
  const id = () => props.agent.agentId;
  // the pace and the changed files come from the run's own log, which is read once and then follows the live events
  onMount(() => void loadRunLog(id()));
  const events = () => runLog(id())?.events ?? [];
  const left = createMemo(() => turnsLeft(contextHistory(events()), props.meter.size));
  const [busy, setBusy] = createSignal(false);
  const fresh = () => {
    setBusy(true);
    const changed = buildCockpit(events(), props.agent.model).files.filter((f) => f.edits > 0).map((f) => f.path);
    continueFresh(id(), changed)
      .then((opened) => (opened ? props.close() : toast.warn(t("toAgent.noDialog"))), failed("tokensaver.fail.fresh"))
      .finally(() => setBusy(false));
  };
  const copy = () => {
    const done = () => toast.info(t("ctxmeter.copied"));
    const fail = () => toast.error(t("ctxmeter.copyFailed"));
    try {
      const p = navigator.clipboard?.writeText(summaryText(props.meter, props.agent.model, left()));
      if (p) void p.then(done, fail);
      else fail();
    } catch {
      fail();
    }
  };
  return (
    <div class="ctxm" data-testid="context-meter" data-tone={props.meter.tone}>
      <div class="ctxm__head">
        <h2 class="ctxm__title">{t("ctxmeter.title")}</h2>
        <IconButton icon={X} label={t("ctxmeter.close")} size="md" onClick={props.close} />
      </div>
      <div class="ctxm__fill">
        <div class="ctxm__numbers">
          <span class="ctxm__used ui-tnum" data-testid="context-meter-used">{shortTokens(props.meter.used)}</span>
          <span class="ctxm__of ui-tnum">{t("ctxmeter.of", { size: shortTokens(props.meter.size) })}</span>
        </div>
        <div class="ctxm__bar" role="img" aria-label={t("ctxmeter.barAria", { percent: props.meter.percent })}>
          <div class="ctxm__bar-fill" style={{ width: `${props.meter.percent}%` }} />
        </div>
        <p class="ctxm__text">{t("ctxmeter.explain")}</p>
      </div>
      <dl class="ctxm__rows">
        <div class="ctxm__row">
          <dt>{t("ctxmeter.model")}</dt>
          <dd>{t("ctxmeter.modelValue", { model: modelLabel(props.agent.model), size: shortTokens(props.meter.size) })}</dd>
        </div>
        <Show when={paceText(left())}>
          {(pace) => (
            <div class="ctxm__row" data-testid="context-meter-pace">
              <dt>{t("ctxmeter.pace")}</dt>
              <dd class="ui-tnum">{pace()}</dd>
            </div>
          )}
        </Show>
      </dl>
      <button type="button" class="ctxm__primary" disabled={busy()} aria-busy={busy()} title={t("tokensaver.context.freshHint")} onClick={fresh}>
        <span class="ctxm__primary-title">{t("ctxmeter.fresh")}</span>
        <span class="ctxm__primary-text">{t("ctxmeter.freshDesc")}</span>
      </button>
      <div class="ctxm__actions">
        <Show when={canCompact(id())}>
          <Button variant="secondary" disabled={compactBusy(id())} title={compactBusy(id()) ? t("tokensaver.context.compactWait") : t("tokensaver.context.compactHint")} onClick={() => void compact(id()).then(props.close, failed("tokensaver.fail.compact"))}>
            {t("ctxmeter.compact")}
          </Button>
        </Show>
        <Button variant="secondary" onClick={copy}>{t("ctxmeter.copy")}</Button>
      </div>
      <p class="ctxm__source">{t("ctxmeter.source")}</p>
    </div>
  );
}

/** Run header: a small ring and the percent of the context window this run uses; a click opens the context meter. */
export function ContextRing(props: { agent: AgentRow }) {
  const meter = createMemo(() => contextMeter(props.agent.usage));
  return (
    <Show when={meter()}>
      {(m) => (
        <Popover
          placement="bottom-end"
          aria-label={t("ctxmeter.title")}
          class="ctxm-popover"
          trigger={(p) => (
            <button {...p} type="button" class="ctxm-ring" data-testid="context-ring" data-tone={m().tone} aria-label={t("ctxmeter.ring", { percent: m().percent })} title={t("ctxmeter.ring", { percent: m().percent })}>
              <Ring fraction={m().fraction} />
              <span class="ctxm-ring__pct ui-tnum" aria-hidden="true">{m().percent}%</span>
            </button>
          )}
        >
          {(api) => <ContextMeterPanel agent={props.agent} meter={m()} close={api.close} />}
        </Popover>
      )}
    </Show>
  );
}
