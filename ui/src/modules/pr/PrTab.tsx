import { createEffect, createMemo, createResource, createSignal, For, on, Show, type JSX } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { repos } from "../../store/workspace";
import { Badge, Button, EmptyState, ExternalLink, GitPullRequestArrow, IconButton, Info, Plus, RefreshCw, Select, Skeleton, TriangleAlert } from "../../ui-kit";
import { prApi } from "./api";
import CreatePrDialog from "./CreatePrDialog";
import { bucketTone, ciTone, isHttps, isJail, reasonText, reviewTone } from "./logic";
import { createRequests } from "./store";
import type { PrCheck, PrSummary } from "./types";
import "./pr.css";

const ciLabel = (s: PrSummary): string => t(`pr.ci.${s.ci}` as MessageKey);
const ciTitle = (s: PrSummary): string => t("pr.ci.counts", { passed: s.checksPassed, failed: s.checksFailed, pending: s.checksPending });

function Badges(props: { pr: PrSummary }) {
  return (
    <div class="pr__badges">
      <Show when={props.pr.isDraft}><Badge size="sm" tone="neutral">{t("pr.draft")}</Badge></Show>
      <Badge size="sm" tone={ciTone(props.pr.ci)} title={ciTitle(props.pr)}>{ciLabel(props.pr)}</Badge>
      <Show when={props.pr.review !== "none"}><Badge size="sm" tone={reviewTone(props.pr.review)}>{t(`pr.review.${props.pr.review}` as MessageKey)}</Badge></Show>
    </div>
  );
}

function PrRows(props: { rows: PrSummary[]; selected: number | undefined; onSelect: (n: number) => void; label: string }) {
  return (
    <ul class="pr__list" aria-label={props.label}>
      <For each={props.rows}>
        {(p) => (
          <li>
            <button type="button" class="pr__row" data-pr={p.number} aria-current={props.selected === p.number ? "true" : undefined} onClick={() => props.onSelect(p.number)}>
              <span class="pr__rowmain">
                <span class="pr__rowtitle ui-truncate" title={p.title}>{p.title}</span>
                <span class="pr__rowsub ui-truncate"><span class="ui-tnum">#{p.number}</span> · <span class="ui-mono">{p.head}</span> → <span class="ui-mono">{p.base}</span></span>
              </span>
              <Badges pr={p} />
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}

function CheckRow(props: { check: PrCheck; onOpen: (url: string) => void }) {
  const c = () => props.check;
  return (
    <li class="pr__check" data-bucket={c().bucket}>
      <Badge size="sm" tone={bucketTone(c().bucket)}>{t(`pr.bucket.${c().bucket}` as MessageKey)}</Badge>
      <span class="pr__checkname ui-truncate" title={c().name}>{c().name}</span>
      <span class="pr__rowsub ui-truncate">{c().workflow}</span>
      <Show when={isHttps(c().link)}>
        <IconButton icon={ExternalLink} size="sm" label={t("pr.openCheck", { name: c().name })} tooltip={t("pr.openBrowser")} onClick={() => props.onOpen(c().link!)} />
      </Show>
    </li>
  );
}

/** Pull requests of the current branch and of the user, with CI and review state; read-only, plus the Create PR flow. */
export default function PrTab() {
  const list = createMemo(() => repos());
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const repoId = () => picked() ?? list()[0]?.id ?? "";
  const repoName = () => list().find((r) => r.id === repoId())?.name ?? repoId();
  const [status, { refetch: refetchStatus }] = createResource(repoId, (id) => (id ? prApi().status(id) : undefined));
  const ready = () => {
    const s = status();
    return !!s && s.installed && !s.blocked && s.authenticated !== false;
  };
  const [prs, { refetch: refetchList }] = createResource(() => (ready() ? repoId() : undefined), (id) => prApi().list(id));
  const [selected, setSelected] = createSignal<number | undefined>(undefined);
  createEffect(on(repoId, () => setSelected(undefined)));
  createEffect(() => {
    const l = prs();
    if (l && selected() === undefined) setSelected((l.current[0] ?? l.mine[0])?.number);
  });
  const [detail] = createResource(
    () => (ready() && selected() !== undefined ? ([repoId(), selected()!] as const) : undefined),
    ([id, n]) => prApi().view(id, n),
  );
  const [creating, setCreating] = createSignal(false);
  createEffect(on(createRequests, (n) => n > 0 && repoId() && setCreating(true)));
  const open = (url: string) => void prApi().openUrl(url).catch(() => {});
  const refresh = () => (void refetchStatus(), void refetchList());
  const mineOther = () => (prs()?.mine ?? []).filter((m) => !(prs()?.current ?? []).some((c) => c.number === m.number));

  const notice = (): JSX.Element => {
    const s = status();
    if (!s) return <Skeleton height={80} />;
    if (!s.installed) return <EmptyState icon={GitPullRequestArrow} title={t("pr.noGh.title")} description={t("pr.noGh.desc")} />;
    if (isJail(s.blocked)) return <EmptyState icon={Info} title={t("pr.jail.title")} description={reasonText({ code: s.blocked as string })} />;
    return <EmptyState icon={TriangleAlert} title={t("pr.noAuth.title")} description={t("pr.noAuth.desc")} />;
  };

  return (
    <div class="pr">
      <div class="pr__bar">
        <h2 class="pr__title">{t("pr.name")}</h2>
        <Select aria-label={t("pr.repo")} size="sm" value={repoId()} onChange={setPicked} options={list().map((r) => ({ value: r.id, label: r.name }))} />
        <span class="pr__spacer" />
        <Button size="sm" variant="secondary" icon={RefreshCw} loading={prs.loading || status.loading} onClick={refresh}>{t("pr.refresh")}</Button>
        <Button size="sm" variant="primary" icon={Plus} disabled={!repoId()} onClick={() => setCreating(true)}>{t("pr.create.open")}</Button>
      </div>
      <Show when={prs.error}><p class="pr__note" data-tone="danger" role="alert">{reasonText(prs.error)}</p></Show>
      <Show when={ready()} fallback={<div class="pr__empty">{notice()}</div>}>
        <div class="pr__split">
          <div class="pr__side">
            <Show when={prs()} fallback={<Skeleton height={120} />}>
              {(l) => (
                <>
                  <h3 class="pr__section">{l().branch ? t("pr.thisBranch", { branch: l().branch as string }) : t("pr.noBranch")}</h3>
                  <Show when={l().current.length} fallback={<p class="pr__hint">{t("pr.noneBranch")}</p>}>
                    <PrRows rows={l().current} selected={selected()} onSelect={setSelected} label={t("pr.listBranchAria")} />
                  </Show>
                  <h3 class="pr__section">{t("pr.mine")}</h3>
                  <Show when={mineOther().length} fallback={<p class="pr__hint">{t("pr.noneMine")}</p>}>
                    <PrRows rows={mineOther()} selected={selected()} onSelect={setSelected} label={t("pr.listMineAria")} />
                  </Show>
                </>
              )}
            </Show>
          </div>
          <div class="pr__detail" aria-live="polite">
            <Show when={detail()} fallback={<Show when={selected() !== undefined && detail.loading}><Skeleton height={160} /></Show>}>
              {(d) => (
                <article class="pr__article" data-pr-detail={d().summary.number}>
                  <header class="pr__head2">
                    <h3 class="pr__dtitle">{d().summary.title}</h3>
                    <Button size="sm" variant="secondary" icon={ExternalLink} disabled={!isHttps(d().summary.url)} onClick={() => open(d().summary.url)}>{t("pr.openOnGithub")}</Button>
                  </header>
                  <p class="pr__rowsub"><span class="ui-tnum">#{d().summary.number}</span> · {d().summary.author} · <span class="ui-mono">{d().summary.head}</span> → <span class="ui-mono">{d().summary.base}</span></p>
                  <Badges pr={d().summary} />
                  <h4 class="pr__section">{t("pr.description")}</h4>
                  <pre class="pr__body">{d().body.trim() || t("pr.noDescription")}</pre>
                  <Show when={d().reviews.length}>
                    <h4 class="pr__section">{t("pr.reviews")}</h4>
                    <ul class="pr__reviews" aria-label={t("pr.reviews")}>
                      <For each={d().reviews}>{(r) => <li><strong>{r.author}</strong> <Badge size="sm" tone={r.state === "APPROVED" ? "ok" : r.state === "CHANGES_REQUESTED" ? "danger" : "neutral"}>{t(`pr.reviewState.${r.state}` as MessageKey)}</Badge></li>}</For>
                    </ul>
                  </Show>
                  <h4 class="pr__section">{t("pr.checks")}</h4>
                  <Show when={d().checks.length} fallback={<p class="pr__hint">{t("pr.noChecks")}</p>}>
                    <ul class="pr__checks" aria-label={t("pr.checks")}>
                      <For each={d().checks}>{(c) => <CheckRow check={c} onOpen={open} />}</For>
                    </ul>
                  </Show>
                </article>
              )}
            </Show>
            <Show when={prs() && !prs()!.current.length && !prs()!.mine.length}>
              <EmptyState size="sm" icon={GitPullRequestArrow} title={t("pr.empty.title")} description={t("pr.empty.desc")} />
            </Show>
          </div>
        </div>
      </Show>
      <CreatePrDialog open={creating()} repoId={repoId()} repoName={repoName()} status={status()} onClose={() => setCreating(false)} onCreated={refresh} />
    </div>
  );
}
