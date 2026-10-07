import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { repos } from "../../store/workspace";
import { errorText } from "../../store/snapshots";
import type { TabInstance } from "../../platform/tabs";
import { Badge, Button, Check, EmptyState, FileDiff, Icon, IconButton, RefreshCw, SegmentedControl, Skeleton, Sparkles, Tag, TextArea, toast, TriangleAlert, X, type Tone } from "../../ui-kit";
import { releaseApi } from "./api";
import { dropItem, entryCount, kindLabel, mergeTranslations, setEnglish, translationJobs } from "./logic";
import type { Bump, Entry, Kind, Plan } from "./types";
import "./release.css";

const KIND_TONE: Record<Kind, Tone> = { feature: "accent", improvement: "info", fix: "ok", performance: "info", security: "danger", internal: "neutral" };

/** The Release tab: commits since the last release, the drafted changelog entry, the version bump and the exact diff. */
export default function ReleaseTab(props: { tab: TabInstance }) {
  const list = createMemo(() => repos());
  const [picked, setPicked] = createSignal<string | undefined>(props.tab.params?.repoId as string | undefined);
  /** The chosen repo, or the first one once the workspace has loaded. */
  const repoId = () => picked() ?? list()[0]?.id ?? "";
  const [bump, setBump] = createSignal<Bump | "auto">("auto");
  const [plan, setPlan] = createSignal<Plan | undefined>(undefined);
  const [entry, setEntry] = createSignal<Entry | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [translating, setTranslating] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const [written, setWritten] = createSignal<string[] | undefined>(undefined);
  const [showCommits, setShowCommits] = createSignal(false);

  async function load() {
    if (!repoId()) return;
    setLoading(true);
    setWritten(undefined);
    try {
      const b = bump();
      const p = await releaseApi().plan(repoId(), b === "auto" ? undefined : b);
      setPlan(p);
      setEntry(p.entry);
      setError(undefined);
    } catch (e) {
      setPlan(undefined);
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  createEffect(on(repoId, () => void load()));

  const request = () => ({ version: plan()!.proposed, entry: plan()!.changelogPath ? (entry() ?? null) : null, changelogPath: plan()!.changelogPath });

  async function translate() {
    const p = plan();
    const e = entry();
    if (!p || !e) return;
    const jobs = translationJobs(e, p.langs);
    if (!jobs.length) return toast.error(t("release.toast.nothing"), t("release.toast.nothingBody"));
    setTranslating(true);
    try {
      const out = mergeTranslations(e, await releaseApi().translate(jobs));
      setEntry(out.entry);
      toast.success(t("release.toast.drafted"), out.skipped ? t("release.toast.draftedSkipped", { added: out.applied, skipped: out.skipped }) : t("release.toast.draftedBody", { added: out.applied }));
    } catch (err) {
      toast.error(t("release.toast.translateFailed"), errorText(err));
    } finally {
      setTranslating(false);
    }
  }

  async function apply() {
    if (!plan() || applying()) return;
    setApplying(true);
    try {
      setWritten(await releaseApi().apply(repoId(), request()));
      toast.success(t("release.toast.updated"), t("release.toast.updatedBody"));
    } catch (err) {
      toast.error(t("release.toast.writeFailed"), errorText(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div class="rel" data-testid="release-tab">
      <header class="rel__bar">
        <Icon icon={Tag} size={16} />
        <h2 class="rel__title">{t("release.name")}</h2>
        <Show when={list().length > 1}>
          <SegmentedControl size="sm" aria-label={t("release.repo")} value={repoId()} onChange={setPicked} options={list().map((r) => ({ value: r.id, label: r.name }))} />
        </Show>
        <span class="rel__spacer" />
        <IconButton icon={RefreshCw} label={t("release.draftAgain")} size="sm" loading={loading()} onClick={() => void load()} />
      </header>

      <Show when={error()}>
        <p class="rel__error" role="alert">
          {error()}
        </p>
      </Show>

      <Show when={plan()} fallback={
          <Show when={!error()}>
            <Show when={list().length} fallback={<EmptyState icon={Tag} size="sm" title={t("release.noRepo")} description={t("release.noRepoDesc")} />}>
              <div class="rel__loading">
                <Skeleton height={22} />
                <Skeleton height={22} />
                <Skeleton height={22} />
              </div>
            </Show>
          </Show>
        }>
        {(p) => (
          <>
            <section class="rel__version" aria-label={t("release.version")}>
              <span class="rel__from">{p().current}</span>
              <span aria-hidden="true">→</span>
              <strong class="rel__to">{p().proposed}</strong>
              <SegmentedControl
                size="sm"
                aria-label={t("release.bump")}
                value={bump() === "auto" ? p().bump : (bump() as Bump)}
                onChange={(b) => (setBump(b), void load())}
                options={[
                  { value: "patch", label: t("release.bump.patch") },
                  { value: "minor", label: t("release.bump.minor") },
                  { value: "major", label: t("release.bump.major") },
                ]}
              />
              <span class="rel__hint">
                {p().baseKind === "tag" ? t("release.sinceTag", { base: p().base, n: p().commits.length }) : p().baseKind === "versionCommit" ? t("release.sinceVersion", { version: p().current, n: p().commits.length }) : t("release.noBase", { n: p().commits.length })}
              </span>
              <Show when={p().tagHint}>
                <code class="rel__tag" title={t("release.tagTip")}>{p().tagHint}</code>
              </Show>
            </section>

            <For each={p().notes}>
              {(n) => (
                <p class="rel__note">
                  <Icon icon={TriangleAlert} size={12} /> {n}
                </p>
              )}
            </For>

            <Show when={entry()?.groups.length} fallback={<EmptyState icon={Tag} size="sm" title={t("release.noEntries")} description={t("release.noEntriesDesc")} />}>
              <section class="rel__entry" aria-label={t("release.entry")}>
                <header class="rel__entryhead">
                  <h3 class="rel__h">{t("release.entry")}</h3>
                  <Badge size="sm" numeric>{t("release.items", { n: entryCount(entry()!) })}</Badge>
                  <span class="rel__spacer" />
                  <Show when={p().langs.length > 1}>
                    <Button size="sm" variant="secondary" icon={Sparkles} loading={translating()} onClick={() => void translate()}>
                      {t("release.translateTo", { n: p().langs.length - 1 })}
                    </Button>
                  </Show>
                </header>
                <label class="rel__field">
                  <span class="rel__label">{t("release.highlightEn")}</span>
                  <TextArea minRows={1} aria-label={t("release.highlight")} value={entry()!.highlight.en ?? ""} onInput={(e) => setEntry(setEnglish(entry()!, "highlight", e.currentTarget.value))} />
                </label>
                <For each={entry()!.groups}>
                  {(g, gi) => (
                    <div class="rel__group">
                      <h4 class="rel__gh">
                        <Badge size="sm" tone={KIND_TONE[g.type as Kind] ?? "neutral"}>{kindLabel(g.type)}</Badge>
                      </h4>
                      <For each={g.items}>
                        {(it, ii) => (
                          <div class="rel__item">
                            <div class="rel__itemtop">
                              <TextArea minRows={1} wrapperClass="rel__grow" aria-label={t("release.titleOf", { type: g.type, n: ii() + 1 })} value={it.title.en ?? ""} onInput={(e) => setEntry(setEnglish(entry()!, { gi: gi(), ii: ii(), field: "title" }, e.currentTarget.value))} />
                              <IconButton icon={X} label={t("release.leaveOut", { title: it.title.en ?? t("release.thisItem") })} size="sm" onClick={() => setEntry(dropItem(entry()!, gi(), ii()))} />
                            </div>
                            <Show when={it.description?.en}>
                              <TextArea minRows={1} aria-label={t("release.descOf", { type: g.type, n: ii() + 1 })} value={it.description?.en ?? ""} onInput={(e) => setEntry(setEnglish(entry()!, { gi: gi(), ii: ii(), field: "description" }, e.currentTarget.value))} />
                            </Show>
                            <Show when={Object.keys(it.title).length > 1}>
                              <span class="rel__hint">{t("release.moreTranslations", { n: Object.keys(it.title).length - 1 })}</span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </section>
            </Show>

            <section class="rel__commits">
              <button type="button" class="rel__toggle" aria-expanded={showCommits()} onClick={() => setShowCommits(!showCommits())}>
                {showCommits() ? t("release.hideCommits", { n: p().commits.length }) : t("release.showCommits", { n: p().commits.length })}
              </button>
              <Show when={showCommits()}>
                <ul class="rel__commitlist">
                  <For each={p().commits}>
                    {(c) => (
                      <li>
                        <Badge size="sm" tone={KIND_TONE[c.kind]}>{kindLabel(c.kind)}</Badge>
                        <code class="rel__hash">{c.hash}</code> {c.scope ? <span class="rel__hint">{c.scope}</span> : null} {c.subject}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            <section class="rel__diff" aria-label={t("release.willChange")}>
              <h3 class="rel__h">
                <Icon icon={FileDiff} size={14} /> {t("release.willChange")}
              </h3>
              <pre class="rel__pre">{p().diff}</pre>
            </section>

            <footer class="rel__foot">
              <Show when={written()} fallback={<span class="rel__hint">{plan()!.changelogPath ? t("release.writesBoth") : t("release.writesPkg")}</span>}>
                <span class="rel__done"><Icon icon={Check} size={14} /> {t("release.updated", { files: fmt.list(written()!) })}</span>
              </Show>
              <span class="rel__spacer" />
              <Button variant="primary" size="sm" loading={applying()} disabled={!!written()} onClick={() => void apply()}>
                {t("release.apply", { version: p().proposed })}
              </Button>
            </footer>
          </>
        )}
      </Show>
    </div>
  );
}
