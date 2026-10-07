import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { modelLabel } from "../../components/chat/format";
import { t } from "../../i18n";
import { activeTab, type TabInstance } from "../../platform/tabs";
import { refreshSnapshots } from "../../store/snapshots";
import { Badge, Button, CircleAlert, EmptyState, History, ListChecks, Rewind, SegmentedControl, Skeleton, StatusDot, Tooltip } from "../../ui-kit";
import { FactsPane } from "./FactsPane";
import { FilesPane } from "./FilesPane";
import { IssuesPane } from "./IssuesPane";
import { openReview } from "./openers";
import { RawPane } from "./RawPane";
import { RewindDialog } from "./rewind/RewindDialog";
import { forkRun, resumeRun } from "./runActions";
import { loadRunLog } from "./runEvents";
import { statsOf } from "./stats";
import { Timeline } from "./Timeline";
import { asRunParams, useInspection } from "./useInspection";
import "./inspector.css";

type Pane = "timeline" | "files" | "init" | "issues" | "raw";

/** Which pane each run's tab shows. Module state, not component state: the centre area remounts a tab every time it is activated. */
const [panes, setPanes] = createSignal<Record<string, Pane>>({});
export const resetInspectorPanes = (): void => void setPanes({});

export default function Inspector(props: { tab: TabInstance }) {
  const params = () => asRunParams(props.tab.params);
  const { log, inspection } = useInspection(params);
  const pane = () => panes()[params().runId] ?? "timeline";
  const setPane = (p: Pane) => setPanes((all) => ({ ...all, [params().runId]: p }));
  const [rewinding, setRewinding] = createSignal(params().rewind === true);
  const [busy, setBusy] = createSignal<"resume" | "fork" | undefined>(undefined);
  const insp = inspection;
  const active = () => log()?.status === "ready" && !insp().finished && insp().eventCount > 0;
  const title = () => params().title ?? insp().title ?? insp().prompt ?? params().runId;
  const stats = createMemo(() => statsOf(insp(), Date.now()));
  const state = () => (insp().stopReason === "error" ? t("inspector.state.failed") : active() ? t("inspector.state.running") : t("inspector.state.finished"));
  const run = async (kind: "resume" | "fork") => {
    setBusy(kind);
    await (kind === "resume" ? resumeRun : forkRun)(params().runId);
    setBusy(undefined);
  };

  return (
    <section class="insp" aria-label={t("inspector.label", { title: title() })} data-active={activeTab()?.id === props.tab.id ? "" : undefined}>
      <Switch>
        <Match when={!log() || log()!.status === "loading"}>
          <div class="insp__loading" aria-busy="true">
            <Skeleton width="40%" height={18} />
            <Skeleton width="100%" height={56} />
            <Skeleton width="100%" height={160} />
          </div>
        </Match>
        <Match when={log()!.status === "expired"}>
          <EmptyState icon={History} title={t("inspector.expired")} description={t("inspector.expiredDesc")} />
        </Match>
        <Match when={log()!.status === "error"}>
          <EmptyState icon={CircleAlert} tone="danger" title={t("inspector.loadFail")} description={log()!.error} action={<Button onClick={() => void loadRunLog(params().runId, { force: true })}>{t("inspector.retry")}</Button>} />
        </Match>
        <Match when={true}>
          <header class="insp__head">
            <div class="insp__title">
              <StatusDot tone={insp().stopReason === "error" ? "danger" : active() ? "accent" : "ok"} label={state()} />
              <h2 class="ui-truncate" title={title()}>{title()}</h2>
              <Show when={params().role}>
                <Badge size="sm">{params().role}</Badge>
              </Show>
              <Show when={insp().init}>
                <Badge size="sm" title={insp().init!.model}>{modelLabel(insp().init!.model)}</Badge>
              </Show>
              <span class="insp__state ui-text-3">{state()}</span>
            </div>
            <div class="insp__actions">
              <Tooltip label={insp().files.length ? t("inspector.reviewTip") : t("inspector.reviewNone")}>
                <span>
                  <Button size="sm" icon={ListChecks} disabled={insp().files.length === 0} onClick={() => openReview(params())}>
                    {t("inspector.reviewRun")}
                  </Button>
                </span>
              </Tooltip>
              <Button size="sm" icon={Rewind} onClick={() => setRewinding(true)}>{t("inspector.rewind")}</Button>
              <Button size="sm" variant="ghost" loading={busy() === "resume"} onClick={() => void run("resume")}>{t("inspector.resume")}</Button>
              <Button size="sm" variant="ghost" loading={busy() === "fork"} onClick={() => void run("fork")}>{t("inspector.fork")}</Button>
            </div>
          </header>
          <dl class="insp__stats" aria-label={t("inspector.totals")}>
            <For each={stats()}>
              {(s) => (
                <div class="insp-stat" data-tone={s.tone} title={s.title}>
                  <dt>{s.label}</dt>
                  <dd class="ui-tnum">{s.value}</dd>
                </div>
              )}
            </For>
          </dl>
          <div class="insp__switch">
            <SegmentedControl<Pane>
              size="sm"
              aria-label={t("inspector.view")}
              value={pane()}
              onChange={setPane}
              options={[
                { value: "timeline", label: t("inspector.pane.timeline", { n: insp().tools.length }) },
                { value: "files", label: t("inspector.pane.files", { n: insp().files.length }) },
                { value: "init", label: t("inspector.pane.session") },
                { value: "issues", label: t("inspector.pane.issues", { n: insp().issues.length }) },
                { value: "raw", label: t("inspector.pane.raw") },
              ]}
            />
          </div>
          <div class="insp__body">
            <Switch>
              <Match when={pane() === "timeline"}>
                <Timeline inspection={insp()} />
              </Match>
              <Match when={pane() === "files"}>
                <FilesPane inspection={insp()} />
              </Match>
              <Match when={pane() === "init"}>
                <FactsPane init={insp().init} roles={insp().roles} costByModel={insp().costByModel} />
              </Match>
              <Match when={pane() === "issues"}>
                <IssuesPane inspection={insp()} />
              </Match>
              <Match when={pane() === "raw"}>
                <RawPane events={log()!.events} start={insp().startedMs ?? 0} />
              </Match>
            </Switch>
          </div>
          <RewindDialog open={rewinding()} onClose={() => setRewinding(false)} runId={params().runId} runActive={active()} onRestored={() => void refreshSnapshots(null)} />
        </Match>
      </Switch>
    </section>
  );
}
