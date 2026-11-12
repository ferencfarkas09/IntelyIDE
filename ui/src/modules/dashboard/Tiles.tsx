import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { agentRows, agentsError, agentsLoaded } from "../../store/agents";
import { repoConfig } from "../../store/workspace";
import { KpiTile } from "../../ui-kit";
import { runResults } from "../autotest/store";
import { autotestEnabled } from "../autotest/toggle";
import { describeEntry } from "../runs/inboxLogic";
import { inbox } from "../runs/inbox";
import { reviewedRuns } from "../runs/reviewed";
import { limits } from "../usage/store";
import { limitTone, pulseOf, testTally, type Pulse } from "./logic";

/** The run counts of the header and the tiles; `undefined` until the runs are known (still loading, or the list failed). */
export function createPulse(): () => Pulse | undefined {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(id));
  });
  return createMemo(() => (agentsLoaded() && !agentsError() ? pulseOf(agentRows(), reviewedRuns(), now()) : undefined));
}

/** The one sentence under the heading: what waits for the person, from the same counts as the tiles. */
export function summaryOf(p: Pulse | undefined): string {
  if (!p) return t("dash.summary.unknown");
  if (p.needsYou > 0 && p.ready > 0) return t("dash.summary.both", { needs: p.needsYou, ready: p.ready });
  if (p.needsYou > 0) return t("dash.summary.needs", { n: p.needsYou });
  if (p.ready > 0) return t("dash.summary.ready", { n: p.ready });
  if (p.running > 0) return t("dash.summary.running", { n: p.running });
  return t("dash.summary.none");
}

/**
 * The number tiles above the cards. Each reads a store another feature already fills and is left out while that source has
 * nothing to say: the runs (needs you, ready for review), the plan limits the usage store last read (weekly window) and the
 * results of "Auto-test after a run".
 */
export function DashTiles(props: { pulse: () => Pulse | undefined }) {
  const week = () => {
    const l = limits();
    return l && l.available && l.sevenDay && Number.isFinite(l.sevenDay.utilization) ? Math.round(Math.max(0, Math.min(100, l.sevenDay.utilization))) : undefined;
  };
  const tests = createMemo(() => (autotestEnabled() ? testTally(agentRows().flatMap((r) => runResults(r.agentId))) : undefined));
  /** Why the oldest open request waits: the command or question itself, else the title of the run. */
  const reason = () => {
    const first = inbox()[0];
    if (first) return describeEntry(first).body || first.runTitle;
    return agentRows().find((r) => r.status === "needsYou")?.title ?? "";
  };
  const repoName = (id: string) => repoConfig(id)?.name ?? id;
  const testHint = () => {
    const bad = tests()?.failing[0];
    if (!bad) return t("dash.tiles.testsAllPass");
    return bad.failed > 0 ? t("dash.tiles.testsFailing", { repo: repoName(bad.repoId), n: bad.failed }) : t("dash.tiles.testsUnfinished", { repo: repoName(bad.repoId) });
  };
  const weekTone = () => {
    const tone = limitTone(week() ?? 0);
    return tone === "ok" ? "accent" : tone;
  };
  return (
    <Show when={props.pulse() || week() !== undefined || tests()}>
      <div class="dash__tiles" role="group" aria-label={t("dash.tiles.aria")} data-testid="dash-tiles">
        <Show when={props.pulse()}>
          {(p) => (
            <>
              <KpiTile
                class="dash-tile"
                label={t("dash.pulse.needsYou")}
                value={fmt.number(p().needsYou)}
                tone={p().needsYou > 0 ? "warn" : undefined}
                hint={<span class="dash-tile__hint">{p().needsYou > 0 ? reason() : t("dash.tiles.needsNone")}</span>}
                hintTone={p().needsYou > 0 ? "warn" : undefined}
              />
              <KpiTile
                class="dash-tile"
                label={t("dash.pulse.ready")}
                value={fmt.number(p().ready)}
                hint={<span class="dash-tile__hint">{p().running > 0 ? t("dash.tiles.working", { n: p().running }) : t("dash.tiles.workingNone")}</span>}
              />
            </>
          )}
        </Show>
        <Show when={week() !== undefined}>
          <KpiTile class="dash-tile" label={t("dash.tiles.week")} value={`${fmt.number(week()!)}%`} meter={week()} meterTone={weekTone()} meterLabel={t("dash.tiles.weekAria", { pct: week()! })} />
        </Show>
        <Show when={tests()}>
          {(tally) => (
            <KpiTile
              class="dash-tile"
              label={t("dash.tiles.tests")}
              value={t("dash.tiles.testsValue", { passing: tally().passing, total: tally().total })}
              hint={<span class="dash-tile__hint">{testHint()}</span>}
              hintTone={tally().failing.length > 0 ? "danger" : "ok"}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}
