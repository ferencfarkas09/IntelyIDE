import { createMemo, For, onMount, Show } from "solid-js";
import { t, fmt } from "../../i18n";
import { Badge, EmptyState, FileText, Icon, MiddleEllipsis, ProgressBar, Skeleton, TriangleAlert } from "../../ui-kit";
import { loadRunLog, runLog } from "../inspector/runEvents";
import { buildCockpit, type CockpitWarning } from "./cockpit";
import { tokens, usd } from "./format";
import "./history.css";

const SOURCE_KEY = { reported: "cockpit.source.reported", estimated: "cockpit.source.estimated", unknown: "cockpit.source.unknown" } as const;
const BASIS_KEY = { billed: "cockpit.basis.billed", estimated: "cockpit.basis.estimated", subscription: "cockpit.basis.subscription", included: "cockpit.basis.included", unknown: "cockpit.basis.unknown" } as const;

const warningText = (w: CockpitWarning): string => {
  switch (w.kind) {
    case "contextHigh":
      return t("cockpit.warn.contextHigh", w.params);
    case "contextCritical":
      return t("cockpit.warn.contextCritical", w.params);
    case "repeatedReads":
      return t("cockpit.warn.repeatedReads", w.params);
    default:
      return t("cockpit.warn.noUsage");
  }
};

/** What one run's context holds: the window fill, usage and cost per turn and per tool, files and attachments, warnings. */
export default function CockpitView(props: { runId: string; model?: string }) {
  onMount(() => void loadRunLog(props.runId));
  const log = () => runLog(props.runId);
  const cockpit = createMemo(() => buildCockpit(log()?.events ?? [], props.model));
  const ctx = () => cockpit().context;
  const tone = () => ((ctx().fraction ?? 0) >= 0.95 ? "danger" : (ctx().fraction ?? 0) >= 0.8 ? "warn" : "accent");
  const maxTurn = () => Math.max(1, ...cockpit().turns.map((x) => (x.inputTokens ?? 0) + (x.outputTokens ?? 0)));

  return (
    <div class="cp" data-run={props.runId}>
      <Show when={log()?.status === "expired"}>
        <EmptyState size="sm" icon={FileText} title={t("cockpit.expired.title")} description={t("cockpit.expired.desc")} />
      </Show>
      <Show when={log()?.status === "error"}>
        <EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("cockpit.error")} description={log()?.error} />
      </Show>
      <Show when={!log() || log()!.status === "loading"}>
        <Skeleton height={64} />
      </Show>
      <Show when={log()?.status === "ready"}>
        <section class="cp__card" aria-label={t("cockpit.window")}>
          <div class="cp__head">
            <h3 class="cp__title">{t("cockpit.window")}</h3>
            <Badge size="sm" tone={ctx().source === "reported" ? "ok" : ctx().source === "estimated" ? "info" : "neutral"} title={t(SOURCE_KEY[ctx().source])}>
              {ctx().source === "reported" ? t("cockpit.sourceShort.reported") : ctx().source === "estimated" ? t("cockpit.sourceShort.estimated") : t("cockpit.sourceShort.unknown")}
            </Badge>
          </div>
          <Show when={ctx().used !== undefined} fallback={<p class="cp__muted">{t("cockpit.source.unknown")}</p>}>
            <Show when={ctx().fraction !== undefined} fallback={<p class="cp__big ui-tnum">{t("cockpit.fillNoWindow", { used: tokens(ctx().used) })}</p>}>
              <ProgressBar aria-label={t("cockpit.windowAria")} value={(ctx().fraction ?? 0) * 100} tone={tone()} />
              <p class="cp__big ui-tnum">{t("cockpit.fill", { used: tokens(ctx().used), size: tokens(ctx().size), percent: Math.round((ctx().fraction ?? 0) * 100) })}</p>
            </Show>
            <p class="cp__muted">{t(SOURCE_KEY[ctx().source])}</p>
          </Show>
        </section>

        <Show when={cockpit().warnings.length}>
          <ul class="cp__warns" aria-label={t("cockpit.warnings")}>
            <For each={cockpit().warnings}>
              {(w) => (
                <li class="cp__warn" data-kind={w.kind}>
                  <Icon icon={TriangleAlert} size={14} />
                  <span>{warningText(w)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <section class="cp__card" aria-label={t("cockpit.usage.title")}>
          <h3 class="cp__title">{t("cockpit.usage.title")}</h3>
          <Show when={cockpit().totals} fallback={<p class="cp__muted">{t("cockpit.warn.noUsage")}</p>}>
            {(u) => (
              <>
                <dl class="cp__tiles">
                  <div><dt>{t("cockpit.usage.input")}</dt><dd class="ui-tnum">{tokens(u().inputTokens)}</dd></div>
                  <div><dt>{t("cockpit.usage.output")}</dt><dd class="ui-tnum">{tokens(u().outputTokens)}</dd></div>
                  <div><dt>{t("cockpit.usage.cache")}</dt><dd class="ui-tnum">{tokens(u().cacheRead)}</dd></div>
                  <div><dt>{t("cockpit.usage.cost")}</dt><dd class="ui-tnum">{usd(u().costUsd)}</dd></div>
                </dl>
                <p class="cp__muted">{t("cockpit.usage.note", { basis: t(BASIS_KEY[u().basis] ?? "cockpit.basis.unknown"), model: u().model })}</p>
              </>
            )}
          </Show>
        </section>

        <section class="cp__card" aria-label={t("cockpit.turns.title")}>
          <h3 class="cp__title">{t("cockpit.turns.title")}</h3>
          <Show when={cockpit().turns.length} fallback={<p class="cp__muted">{t("cockpit.turns.none")}</p>}>
            <table class="cp__table">
              <thead>
                <tr>
                  <th scope="col">{t("cockpit.col.turn")}</th>
                  <th scope="col" class="cp__num">{t("cockpit.col.tools")}</th>
                  <th scope="col">{t("cockpit.col.tokens")}</th>
                  <th scope="col" class="cp__num">{t("cockpit.col.cost")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={cockpit().turns}>
                  {(turn) => (
                    <tr>
                      <th scope="row" class="ui-tnum">{turn.index}</th>
                      <td class="cp__num ui-tnum">{turn.tools}</td>
                      <td>
                        <span class="cp__bar" aria-hidden="true"><span style={{ width: `${(((turn.inputTokens ?? 0) + (turn.outputTokens ?? 0)) / maxTurn()) * 100}%` }} /></span>
                        <span class="cp__bar-label ui-tnum">{t("cockpit.inOut", { input: tokens(turn.inputTokens), output: tokens(turn.outputTokens) })}</span>
                      </td>
                      <td class="cp__num ui-tnum">{usd(turn.costUsd)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </section>

        <section class="cp__card" aria-label={t("cockpit.tools.title")}>
          <h3 class="cp__title">{t("cockpit.tools.title")}</h3>
          <Show when={cockpit().tools.length} fallback={<p class="cp__muted">{t("cockpit.tools.none")}</p>}>
            <table class="cp__table">
              <thead>
                <tr>
                  <th scope="col">{t("cockpit.col.tool")}</th>
                  <th scope="col" class="cp__num">{t("cockpit.col.calls")}</th>
                  <th scope="col" class="cp__num">{t("cockpit.col.errors")}</th>
                  <th scope="col" class="cp__num">{t("cockpit.col.estTokens")}</th>
                  <th scope="col" class="cp__num">{t("cockpit.col.estCost")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={cockpit().tools}>
                  {(tool) => (
                    <tr>
                      <th scope="row" class="ui-mono">{tool.name}</th>
                      <td class="cp__num ui-tnum">{tool.calls}</td>
                      <td class="cp__num ui-tnum">{tool.errors || "–"}</td>
                      <td class="cp__num ui-tnum">{tokens(tool.estTokens)}</td>
                      <td class="cp__num ui-tnum">{usd(tool.estCostUsd)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <p class="cp__muted">{t("cockpit.tools.note")}</p>
          </Show>
        </section>

        <section class="cp__card" aria-label={t("cockpit.files.title")}>
          <h3 class="cp__title">{t("cockpit.files.title")}</h3>
          <Show when={cockpit().files.length} fallback={<p class="cp__muted">{t("cockpit.files.none")}</p>}>
            <ul class="cp__files">
              <For each={cockpit().files}>
                {(f) => (
                  <li class="cp__file">
                    <MiddleEllipsis class="cp__path ui-mono" text={f.path} />
                    <Show when={f.reads}><Badge size="sm" tone="info" numeric>{t("cockpit.reads", { n: f.reads })}</Badge></Show>
                    <Show when={f.edits}><Badge size="sm" tone="accent" numeric>{t("cockpit.edits", { n: f.edits })}</Badge></Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="cp__card" aria-label={t("cockpit.attachments.title")}>
          <h3 class="cp__title">{t("cockpit.attachments.title")}</h3>
          <Show when={cockpit().attachments.length} fallback={<p class="cp__muted">{t("cockpit.attachments.none")}</p>}>
            <ul class="cp__files">
              <For each={cockpit().attachments}>
                {(a) => (
                  <li class="cp__file">
                    <span class="cp__path ui-truncate" title={a.name}>{a.name}</span>
                    <Badge size="sm" tone="neutral">{a.kind}</Badge>
                    <span class="cp__muted ui-tnum">{fmt.number(Math.max(1, Math.round(a.size / 1024)))} KB</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>
    </div>
  );
}
