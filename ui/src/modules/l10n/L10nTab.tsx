import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import { t } from "../../i18n";
import { repos } from "../../store/workspace";
import type { TabInstance } from "../../platform/tabs";
import { Badge, Button, Check, CircleAlert, EmptyState, FileDiff, Globe, Icon, IconButton, RefreshCw, SegmentedControl, Skeleton, Sparkles, TextArea, toast, TriangleAlert, X } from "../../ui-kit";
import { errorText } from "../../store/snapshots";
import { l10nApi } from "./api";
import { CELL_LABEL, draftItems, edits, proposals, samePlaceholders, summarize, targets } from "./logic";
import { analyzeError, analyzing, refresh, reportOf } from "./store";
import type { CellState, Proposal } from "./types";
import "./l10n.css";

const GLYPH: Record<CellState, () => JSX.Element> = {
  ok: () => <Icon icon={Check} size={14} />,
  missing: () => <span aria-hidden="true">—</span>,
  placeholder: () => <Icon icon={TriangleAlert} size={14} />,
  plural: () => <Icon icon={TriangleAlert} size={14} />,
  noFile: () => <Icon icon={CircleAlert} size={14} />,
};

/** The Localization tab: the matrix of changed keys by language, and the review list for drafted translations. */
export default function L10nTab(props: { tab: TabInstance }) {
  const list = createMemo(() => repos());
  const [picked, setPicked] = createSignal<string | undefined>(props.tab.params?.repoId as string | undefined);
  /** The chosen repo, or the first one once the workspace has loaded. */
  const repoId = () => picked() ?? list()[0]?.id ?? "";
  const report = () => reportOf(repoId());
  const [review, setReview] = createSignal<Proposal[] | undefined>(undefined);
  const [drafting, setDrafting] = createSignal(false);
  const [writing, setWriting] = createSignal(false);
  const [langFilter, setLangFilter] = createSignal<string | undefined>(undefined);

  createEffect(on(repoId, (id) => id && void refresh(id)));
  const pick = (id: string) => {
    setPicked(id);
    setReview(undefined);
  };
  const summary = createMemo(() => (report() ? summarize(report()!) : undefined));
  const todo = createMemo(() => (report() ? targets(report()!, langFilter() ? [langFilter()!] : undefined) : []));

  async function translate() {
    const ts = todo();
    if (!ts.length || drafting()) return;
    setDrafting(true);
    try {
      const drafted = await l10nApi().draft(draftItems(ts));
      const ps = proposals(ts, drafted);
      if (!ps.length) toast.error(t("l10n.toast.noDraft"), t("l10n.toast.noDraftBody"));
      else setReview(ps);
    } catch (e) {
      toast.error(t("l10n.toast.draftFailed"), errorText(e));
    } finally {
      setDrafting(false);
    }
  }

  const patch = (id: string, change: Partial<Proposal>) => setReview((all) => all?.map((p) => (p.id === id ? { ...p, ...change } : p)));
  const accepted = () => (review() ?? []).filter((p) => p.decision === "accepted").length;

  async function write() {
    const ps = review() ?? [];
    const es = edits(ps);
    if (!es.length || writing()) return;
    setWriting(true);
    try {
      const done = await l10nApi().apply(repoId(), es);
      toast.success(t("l10n.toast.written"), t("l10n.toast.writtenBody", { keys: done.written, files: done.files.length }));
      const rest = ps.filter((p) => p.decision !== "accepted");
      setReview(rest.length ? rest : undefined);
      await refresh(repoId());
    } catch (e) {
      toast.error(t("l10n.toast.writeFailed"), errorText(e));
    } finally {
      setWriting(false);
    }
  }

  return (
    <div class="l10n" data-testid="l10n-tab">
      <header class="l10n__bar">
        <Icon icon={Globe} size={16} />
        <h2 class="l10n__title">{t("l10n.name")}</h2>
        <Show when={list().length > 1}>
          <SegmentedControl size="sm" aria-label={t("l10n.repo")} value={repoId()} onChange={pick} options={list().map((r) => ({ value: r.id, label: r.name }))} />
        </Show>
        <span class="l10n__spacer" />
        <IconButton icon={RefreshCw} label={t("l10n.checkAgain")} size="sm" loading={analyzing(repoId())} onClick={() => void refresh(repoId())} />
        <Button variant="primary" size="sm" icon={Sparkles} loading={drafting()} disabled={!todo().length || !!review()} onClick={() => void translate()}>
          {todo().length ? t("l10n.translateN", { n: todo().length }) : t("l10n.translate")}
        </Button>
      </header>

      <Show when={!list().length}>
        <EmptyState icon={Globe} size="sm" title={t("l10n.noRepo")} description={t("l10n.noRepoDesc")} />
      </Show>

      <Show when={analyzeError(repoId())}>
        <p class="l10n__error" role="alert">
          {analyzeError(repoId())}
        </p>
      </Show>

      <Show
        when={report()}
        fallback={
          <Show when={list().length && !analyzeError(repoId())}>
            <div class="l10n__loading">
              <Skeleton height={20} />
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          </Show>
        }
      >
        {(r) => (
          <Show when={r().layout !== "none"} fallback={<EmptyState icon={Globe} size="sm" title={t("l10n.noLocale")} description={t("l10n.noLocaleDesc")} />}>
            <div class="l10n__summary">
              <Badge tone="neutral" numeric>
                {t("l10n.changedKeys", { n: summary()!.keys })}
              </Badge>
              <Badge tone={summary()!.missing ? "warn" : "ok"} numeric>
                {t("l10n.missingN", { n: summary()!.missing })}
              </Badge>
              <Badge tone={summary()!.problems ? "danger" : "ok"} numeric>
                {t("l10n.toFixN", { n: summary()!.problems })}
              </Badge>
              <span class="l10n__hint">
                {t("l10n.layoutLine", { layout: r().layout, langs: r().langs.length, catalogs: r().catalogs, changed: r().changed })}
              </span>
              <Show when={r().skipped > 0}>
                <Badge tone="neutral" title={t("l10n.notScannedTip")}>
                  {t("l10n.notScanned", { n: r().skipped })}
                </Badge>
              </Show>
            </div>

            <Show when={!review()}>
              <Show when={r().groups.length} fallback={<EmptyState icon={Check} size="sm" title={t("l10n.nothing")} description={t("l10n.nothingDesc")} />}>
                <div class="l10n__scroll">
                  <table class="l10n__matrix">
                    <thead>
                      <tr>
                        <th scope="col" class="l10n__keycol">
                          {t("l10n.key")}
                        </th>
                        <For each={r().langs}>
                          {(lang) => {
                            const tot = () => r().totals.find((x) => x.lang === lang);
                            return (
                              <th scope="col" class="l10n__lang" data-active={langFilter() === lang ? "" : undefined}>
                                <button type="button" class="l10n__langbtn" aria-pressed={langFilter() === lang} title={t("l10n.onlyDraft", { lang })} onClick={() => setLangFilter(langFilter() === lang ? undefined : lang)}>
                                  {lang}
                                </button>
                                <Show when={tot() && tot()!.missing + tot()!.problems > 0}>
                                  <span class="l10n__count" data-tone={tot()!.problems ? "danger" : "warn"}>
                                    {tot()!.missing + tot()!.problems}
                                  </span>
                                </Show>
                              </th>
                            );
                          }}
                        </For>
                      </tr>
                    </thead>
                    <For each={r().groups}>
                      {(g) => (
                        <tbody>
                          <tr class="l10n__group">
                            <th colspan={r().langs.length + 1} scope="colgroup">
                              {g.group}
                              <Show when={g.truncated}>
                                <Badge tone="neutral" size="sm">
                                  {t("l10n.firstKeys", { n: g.rows.length })}
                                </Badge>
                              </Show>
                            </th>
                          </tr>
                          <For each={g.rows}>
                            {(row) => (
                              <tr class="l10n__row">
                                <th scope="row" class="l10n__keycol" title={`${row.reference}\n(${row.refLang}) ${row.files.join(", ")}`}>
                                  <span class="l10n__key">{row.key}</span>
                                  <Badge size="sm" tone={row.reason === "used" ? "info" : "accent"}>
                                    {row.plural ? t("l10n.reasonPlural", { reason: t(`l10n.reason.${row.reason}`) }) : t(`l10n.reason.${row.reason}`)}
                                  </Badge>
                                </th>
                                <For each={r().langs}>
                                  {(lang) => {
                                    const c = () => row.cells[lang];
                                    const label = () => `${lang}: ${CELL_LABEL[c()?.state ?? "ok"]}${c()?.note ? ` (${c()!.note})` : ""}`;
                                    return (
                                      <td class="l10n__cell" data-state={c()?.state}>
                                        <span class="l10n__glyph" role="img" aria-label={label()} title={label()}>
                                          {GLYPH[c()?.state ?? "ok"]()}
                                        </span>
                                      </td>
                                    );
                                  }}
                                </For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      )}
                    </For>
                  </table>
                </div>
              </Show>
              <Show when={r().undefined.length}>
                <section class="l10n__undef" aria-label={t("l10n.undefAria")}>
                  <h3 class="l10n__h">
                    <Icon icon={CircleAlert} size={14} /> {t("l10n.undef")}
                  </h3>
                  <ul>
                    <For each={r().undefined}>
                      {(u) => (
                        <li>
                          <code>{u.key}</code> <span class="l10n__hint">{u.files.join(", ")}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
            </Show>
          </Show>
        )}
      </Show>

      <Show when={review()}>
        {(ps) => (
          <section class="l10n__review" aria-label={t("l10n.review.aria")}>
            <header class="l10n__reviewbar">
              <Icon icon={FileDiff} size={16} />
              <h3 class="l10n__h">{t("l10n.review.title")}</h3>
              <span class="l10n__hint">{t("l10n.review.hint")}</span>
              <span class="l10n__spacer" />
              <Button size="sm" variant="ghost" onClick={() => setReview((all) => all?.map((p) => (p.valid && p.decision === "pending" ? { ...p, decision: "accepted" } : p)))}>
                {t("l10n.review.acceptAll")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReview(undefined)}>
                {t("l10n.review.discard")}
              </Button>
              <Button size="sm" variant="primary" loading={writing()} disabled={!accepted()} onClick={() => void write()}>
                {t("l10n.review.write", { n: accepted() })}
              </Button>
            </header>
            <ul class="l10n__proposals">
              <For each={ps()}>
                {(p) => (
                  <li class="l10n__proposal" data-decision={p.decision} data-valid={p.valid ? "" : undefined}>
                    <div class="l10n__ptop">
                      <Badge size="sm" tone="accent">
                        {p.lang}
                      </Badge>
                      <code class="l10n__pkey">
                        {p.group} / {p.key}
                      </code>
                      <span class="l10n__spacer" />
                      <IconButton icon={Check} label={t("l10n.review.accept", { lang: p.lang, key: p.key })} size="sm" pressed={p.decision === "accepted"} onClick={() => patch(p.id, { decision: p.decision === "accepted" ? "pending" : "accepted" })} />
                      <IconButton icon={X} label={t("l10n.review.reject", { lang: p.lang, key: p.key })} size="sm" pressed={p.decision === "rejected"} onClick={() => patch(p.id, { decision: p.decision === "rejected" ? "pending" : "rejected" })} />
                    </div>
                    <p class="l10n__ref">
                      <span class="l10n__hint">{p.refLang}</span> {p.reference}
                    </p>
                    <TextArea
                      aria-label={t("l10n.review.textFor", { lang: p.lang, key: p.key })}
                      minRows={1}
                      value={p.text}
                      invalid={!p.valid}
                      onInput={(e) => {
                        const text = e.currentTarget.value;
                        patch(p.id, { text, valid: !!text.trim() && samePlaceholders(text, p.reference), note: undefined, decision: p.decision === "accepted" ? "pending" : p.decision });
                      }}
                    />
                    <Show when={!p.valid}>
                      <p class="l10n__warn" role="alert">
                        <Icon icon={TriangleAlert} size={12} /> {p.note ?? t("l10n.review.differ")}
                      </p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </Show>
    </div>
  );
}
