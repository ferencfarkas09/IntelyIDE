import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import type { TabInstance } from "../../platform/tabs";
import { ArrowLeft, ArrowRight, Badge, Braces, Button, CircleAlert, Database, EmptyState, EnvPill, IconButton, ListTree, Lock, ProgressBar, RefreshCw, SegmentedControl, Select, Skeleton, Sparkles, Table2, TriangleAlert, Unplug } from "../../ui-kit";
import type { CodeEditorHandle } from "../../ui-kit/CodeEditor";
import { AiBar } from "./AiBar";
import { registerController } from "./controller";
import { ExplainView } from "./ExplainView";
import { clearLost, lostConnections, type CollectionTabParams } from "./gate";
import { levelNote, rangeLabel, roleView } from "./logic";
import { createProductionGate, loudness, ProductionBar, TlsChips, WriterBanner } from "./loudChip";
import { createCollectionModel, PAGE_SIZES } from "./model";
import { openCollection } from "./open";
import { QueryBar } from "./QueryBar";
import { ResultView } from "./ResultView";
import { ReviewStrip } from "./ReviewStrip";
import { connect, profileById, refreshProfiles, stateOf, loaded } from "./store";
import "./manage.css";
import "./mongo.css";

type Sub = "documents" | "explain";

/** A collection: AI bar, review strip, query bar, then the documents (table, tree, JSON) or the Explain view. */
export default function CollectionTab(props: { tab: TabInstance }) {
  const p = props.tab.params as unknown as CollectionTabParams;
  const ref = { connectionId: p.connectionId, db: p.db, collection: p.collection };
  const profile = () => profileById(p.connectionId);
  const m = createCollectionModel(ref, profile);
  const [sub, setSub] = createSignal<Sub>("documents");
  const [booting, setBooting] = createSignal(true);
  const [bootError, setBootError] = createSignal<string>();
  let aiInput: HTMLInputElement | undefined;
  let filterEditor: CodeEditorHandle | undefined;
  const conn = () => stateOf(p.connectionId);
  const gate = createProductionGate();
  const level = () => levelNote(profile() ?? { environment: p.environment, effectiveLevel: p.dangerous ? "productionLevel" : "local", levelOverride: false });

  async function boot() {
    setBooting(true);
    setBootError(undefined);
    if (!loaded()) await refreshProfiles();
    const pr = profile();
    if (pr && stateOf(p.connectionId).status !== "connected" && !(await gate.guard(pr))) {
      setBootError(t("mongoLoud.confirm.declined"));
      return setBooting(false);
    }
    if (!(await connect(p.connectionId))) {
      setBootError(stateOf(p.connectionId).error ?? t("mongoLoud.tab.couldNotConnect"));
      return setBooting(false);
    }
    setBooting(false);
    void m.loadDigest();
    // A tenant lock refuses an unconstrained find: do not fire one, ask for the filter instead.
    if (profile()?.tenantLock) queueMicrotask(() => filterEditor?.focus());
    else void m.run();
  }
  onMount(() => void boot());

  // The connection ended on its own (the SSH master died, the network dropped, the Mac slept): say so, never reconnect silently (5.12).
  const lost = () => (conn().status === "connected" ? undefined : lostConnections()[p.connectionId]);

  const runAny = () => (m.ai.draft() ? void m.ai.runDraft() : void m.run());
  const off = registerController({
    tabId: props.tab.id,
    focusAi: () => aiInput?.focus(),
    run: runAny,
    find: () => void m.run(),
    reset: () => void m.reset(),
    cancel: m.cancel,
    explain: () => (setSub("explain"), void m.explain(false)),
    discard: () => m.ai.discardDraft(),
    refreshSchema: () => void m.loadDigest(),
    setView: (v) => (setSub("documents"), m.setView(v)),
    hasDraft: () => !!m.ai.draft(),
    loading: () => m.status() === "loading",
  });
  onCleanup(off);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (m.ai.status() === "asking") return (e.preventDefault(), m.ai.cancelAsk());
    if (m.ai.draft()) (e.preventDefault(), m.ai.discardDraft());
  };

  const loudProfile = () => profile() ?? { name: p.connectionName, host: "", environment: p.environment, effectiveLevel: p.dangerous ? ("productionLevel" as const) : ("local" as const), tlsRelax: "none" as const };
  const loud = () => loudness(loudProfile());
  const role = () => roleView(conn().view?.role);
  const rangeText = () => rangeLabel(m.page(), m.applied().pageSize, m.docs().length, m.total(), m.hasMore());

  return (
    <section class="mg-tab" data-danger={loud().production ? "" : undefined} aria-label={t("mongoLoud.tab.aria", { collection: p.collection, db: p.db })} onKeyDown={onKeyDown}>
      <ProductionBar profile={loudProfile()} />
      <WriterBanner role={conn().view?.role} />
      <Show when={lost()}>
        {(l) => (
          <div class="mm-banner" data-tone="danger" role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>{l().tunnel ? t("mongoManage.lost.tunnel", { name: p.connectionName }) : t("mongoManage.lost.body", { name: p.connectionName })}</span>
            <Button size="sm" variant="secondary" loading={booting()} onClick={() => void boot()}>{t("mongoManage.lost.reconnect")}</Button>
            <Button size="sm" variant="ghost" onClick={() => clearLost(p.connectionId)}>{t("mongoManage.dismiss")}</Button>
          </div>
        )}
      </Show>
      <header class="mg-tab__head">
        <Database size={14} class="ui-text-3" />
        <span class="mg-tab__crumb ui-truncate">
          <span>{p.connectionName}</span> <span class="ui-text-3">›</span> <span>{p.db}</span> <span class="ui-text-3">›</span> <strong>{p.collection}</strong>
        </span>
        <EnvPill env={loud().production ? "production" : p.environment} size="sm" />
        <Badge size="sm" icon={Lock} title={t("mongoLoud.tab.readOnlyTitle")}>{t("mongoLoud.tab.readOnly")}</Badge>
        <TlsChips profile={loudProfile()} />
        <Show when={conn().view}>
          <Badge size="sm" tone={role().tone} title={role().detail}>{role().label}</Badge>
        </Show>
        <Show when={level()}>{(n) => <Badge size="sm" tone={p.dangerous ? "danger" : "warn"} title={n()}>{p.dangerous && p.environment !== "production" ? t("mongoLoud.tab.productionLevel") : t("mongoLoud.tab.levelLowered")}</Badge>}</Show>
        <span class="mg-tab__spacer" />
        <SegmentedControl<Sub> size="sm" aria-label={t("mongoLoud.tab.viewAria")} value={sub()} onChange={(v) => (setSub(v), v === "explain" && !m.explainResult() && void m.explain(false))} options={[{ value: "documents", label: t("mongoLoud.tab.documents") }, { value: "explain", label: t("mongoLoud.tab.explain") }]} />
        <IconButton icon={RefreshCw} label={t("mongoLoud.tab.refreshHints")} size="sm" loading={m.digestBusy()} onClick={() => void m.loadDigest()} />
      </header>

      <Show when={!booting()} fallback={<div class="mg-tab__boot"><Skeleton height={36} /><Skeleton height={24} width="60%" /><Skeleton height={220} /></div>}>
        <Show
          when={!bootError()}
          fallback={<EmptyState tone="danger" icon={Unplug} title={t("mongoLoud.tab.connectFailed", { name: p.connectionName })} description={bootError()} action={<Button onClick={() => void boot()}>{t("mongoLoud.tab.retry")}</Button>} />}
        >
          <AiBar m={m} connectionId={p.connectionId} inputRef={(el) => (aiInput = el)} />
          <ReviewStrip m={m} dangerous={p.dangerous} onEdit={() => filterEditor?.focus()} collection={p.collection} onOpenCollection={(c) => { const pr = profile(); if (pr) openCollection(pr, p.db, c); }} />
          <QueryBar m={m} tenantLock={profile()?.tenantLock} onSubmit={runAny} filterRef={(h) => (filterEditor = h)} />
          <Show when={m.ai.accepted() && m.status() === "ready" && m.ai.status() !== "asking"}>
            <div class="mg-chips" role="group" aria-label={t("mongoLoud.tab.afterAria")}>
              <span class="ui-text-3">{t("mongoLoud.tab.generatedRan")}</span>
              <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => (setSub("explain"), void m.explain(false))}>{t("mongoLoud.tab.explain")}</Button>
              <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => void m.ai.fix()}>{t("mongoLoud.tab.fix")}</Button>
            </div>
          </Show>

          <Show when={sub() === "documents"} fallback={<ExplainView m={m} estimated={m.total()?.value} />}>
            <div class="mg-docs" data-stale={m.ai.draft() ? "" : undefined}>
              <Show when={m.status() === "loading"}><ProgressBar class="mg-docs__progress" aria-label={t("mongoLoud.tab.loadingDocs")} size="sm" /></Show>
              <div class="mg-docs__bar">
                <SegmentedControl<"table" | "tree" | "json"> size="sm" aria-label={t("mongoLoud.tab.docView")} value={m.view()} onChange={m.setView} options={[{ value: "table", icon: Table2, label: t("mongoLoud.tab.table") }, { value: "tree", icon: ListTree, label: t("mongoLoud.tab.tree") }, { value: "json", icon: Braces, label: t("mongoLoud.tab.json") }]} />
                <span class="mg-tab__spacer" />
                <Show when={m.ai.draft()}><span class="ui-text-3 mg-docs__stale">{t("mongoLoud.tab.previousStale")}</span></Show>
                <Show when={m.status() === "loading"}><Button size="sm" variant="secondary" onClick={m.cancel}>{t("mongoLoud.tab.cancel")}</Button></Show>
              </div>
              <div class="mg-docs__main">
                <Show when={m.status() === "error"}>
                  <EmptyState
                    tone="danger"
                    icon={CircleAlert}
                    title={m.error()?.title ?? t("mongoLoud.tab.wrong")}
                    description={m.error()?.detail}
                    action={
                      // a refused query cannot succeed on its own: edit it instead of retrying it
                      ["mongoRejected", "mongoParse"].includes(m.error()?.code ?? "") ? <Button size="sm" onClick={() => filterEditor?.focus()}>{t("mongoLoud.tab.editFilter")}</Button> : <Button size="sm" onClick={() => void m.run()}>{t("mongoLoud.tab.retry")}</Button>
                    }
                  />
                </Show>
                <Show when={m.status() === "idle" && !m.ran() && profile()?.tenantLock}>
                  <EmptyState icon={Lock} title={t("mongoLoud.tab.tenantTitle", { field: profile()?.tenantLock ?? "" })} description={t("mongoLoud.tab.tenantDesc", { field: profile()?.tenantLock ?? "", example: `{ ${profile()?.tenantLock}: ObjectId("…") }` })} action={<Button size="sm" onClick={() => filterEditor?.focus()}>{t("mongoLoud.tab.editFilter")}</Button>} />
                </Show>
                <Show when={m.status() === "idle" && !m.ran() && !profile()?.tenantLock}>
                  <EmptyState icon={Table2} title={t("mongoLoud.tab.runTitle")} description={t("mongoLoud.tab.runDesc")} action={<Button variant="primary" onClick={() => void m.run()}>{t("mongoLoud.query.find")}</Button>} />
                </Show>
                <Show when={m.status() === "loading" && m.docs().length === 0}>
                  <div class="mg-tab__boot"><Skeleton height={26} /><Skeleton height={20} /><Skeleton height={20} /><Skeleton height={20} /><Skeleton height={20} /></div>
                </Show>
                <Show when={m.ran() && m.status() !== "error" && m.docs().length === 0 && m.status() !== "loading"}>
                  <EmptyState icon={TriangleAlert} title={t("mongoLoud.tab.noMatchTitle")} description={t("mongoLoud.tab.noMatchDesc")} action={<Button size="sm" onClick={() => void m.reset()}>{t("mongoLoud.tab.resetQuery")}</Button>} />
                </Show>
                <Show when={m.docs().length > 0 && m.status() !== "error"}>
                  <ResultView m={m} />
                </Show>
              </div>
              <footer class="mg-docs__foot">
                <span class="ui-tnum mg-docs__range" role="status" aria-live="polite">{rangeText()}</span>
                <IconButton icon={ArrowLeft} label={t("mongoLoud.tab.prev")} size="sm" disabled={m.page() === 0 || m.status() === "loading"} onClick={() => void m.goto(m.page() - 1)} />
                <IconButton icon={ArrowRight} label={t("mongoLoud.tab.next")} size="sm" disabled={m.page() >= m.lastPage() || m.status() === "loading" || m.docs().length === 0} onClick={() => void m.goto(m.page() + 1)} />
                <Select<string> size="sm" aria-label={t("mongoLoud.tab.rowsPerPage")} value={String(m.pageSize())} onChange={(v) => m.setPageSize(Number(v))} options={PAGE_SIZES.map((n) => ({ value: String(n), label: t("mongoLoud.tab.perPage", { n }) }))} />
                <span class="mg-tab__spacer" />
                <Show when={m.ran()}><span class="ui-text-3 ui-tnum">{t("mongoLoud.tab.took", { ms: m.tookMs() })}</span></Show>
                <Show when={m.servedBy() === "secondary" && m.ran()}><Badge size="sm" title={t("mongoLoud.tab.secondaryTitle")}>{t("mongoLoud.tab.secondary")}</Badge></Show>
                <Show when={m.truncated()}><Badge size="sm" tone="warn" title={t("mongoLoud.tab.cappedTitle")}>{t("mongoLoud.tab.capped")}</Badge></Show>
              </footer>
            </div>
          </Show>
        </Show>
      </Show>
      {gate.dialog()}
    </section>
  );
}
