import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { repoConfig, repos } from "../../store/workspace";
import { errorText } from "../../store/snapshots";
import { Badge, Button, Check, EmptyState, FileDiff, Hash, Icon, IconButton, Input, RefreshCw, RepoBadge, RotateCcw, Skeleton, toast, TriangleAlert } from "../../ui-kit";
import { versionsApi } from "./api";
import { bumpRepo, changesOf, countChanges, isPlaceholder, setAllVersions, validValue, versionValues, type Edits } from "./logic";
import type { Bump, Field, FilePlan, Kind, RepoVersions } from "./types";
import "./versions.css";

const KIND_LABEL = {
  packageJson: "versions.kind.packageJson",
  pbxproj: "versions.kind.pbxproj",
  infoPlist: "versions.kind.infoPlist",
  gradle: "versions.kind.gradle",
  cargo: "versions.kind.cargo",
  tauri: "versions.kind.tauri",
  expo: "versions.kind.expo",
  pyproject: "versions.kind.pyproject",
  pubspec: "versions.kind.pubspec",
} as const satisfies Record<Kind, string>;
const BUMPS = [
  { how: "patch", key: "versions.bump.patch" },
  { how: "minor", key: "versions.bump.minor" },
  { how: "major", key: "versions.bump.major" },
  { how: "build", key: "versions.bump.build" },
] as const satisfies readonly { how: Bump | "build"; key: string }[];

/** The fields of a repo grouped by the file they live in, in path order. */
function byFile(repo: RepoVersions): { path: string; kind: Kind; fields: Field[] }[] {
  const out: { path: string; kind: Kind; fields: Field[] }[] = [];
  for (const f of repo.fields) {
    const last = out[out.length - 1];
    if (last && last.path === f.path) last.fields.push(f);
    else out.push({ path: f.path, kind: f.kind, fields: [f] });
  }
  return out;
}

/** The Versions tab: every repository of the workspace, its version files, and buttons that change them together. */
export default function VersionsTab() {
  const [data, setData] = createSignal<RepoVersions[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [edits, setEdits] = createSignal<Record<string, Edits>>({});
  const [diffs, setDiffs] = createSignal<Record<string, FilePlan[]>>({});
  const [planErrors, setPlanErrors] = createSignal<Record<string, string>>({});
  /** Why a repository could not be written; stays until the next Apply so it can be read and acted on. */
  const [applyErrors, setApplyErrors] = createSignal<Record<string, string>>({});
  const [applying, setApplying] = createSignal(false);

  const nameOf = (repoId: string): string => repoConfig(repoId)?.name ?? repoId;
  const withFiles = createMemo(() => data().filter((r) => r.fields.length > 0));
  const withoutFiles = createMemo(() => data().filter((r) => r.fields.length === 0));
  const editsOf = (repoId: string): Edits => edits()[repoId] ?? {};
  const total = createMemo(() => countChanges(data(), edits()));
  const touched = createMemo(() => data().filter((r) => changesOf(r, editsOf(r.repoId)).length > 0));
  /** A pending value the files would not accept: marked in the row, and Apply stays off. */
  const invalid = (repoId: string, f: Field): boolean => {
    const v = editsOf(repoId)[f.id];
    return v !== undefined && v.trim() !== "" && v !== f.value && !validValue(f, v.trim());
  };
  const hasInvalid = createMemo(() => data().some((r) => r.fields.some((f) => invalid(r.repoId, f))));

  async function load() {
    setLoading(true);
    try {
      setData(await versionsApi().scan());
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }
  createEffect(on(() => repos().map((r) => r.id).join(","), () => void load()));

  const setEdit = (repoId: string, next: Edits) => setEdits({ ...edits(), [repoId]: next });
  const clearRepo = (repoId: string) => {
    const { [repoId]: _gone, ...rest } = edits();
    setEdits(rest);
  };
  const bumpOne = (repo: RepoVersions, how: Bump | "build") => setEdit(repo.repoId, bumpRepo(repo, how, editsOf(repo.repoId)));
  const bumpEvery = (how: Bump | "build") => {
    let next = edits();
    for (const r of withFiles()) next = { ...next, [r.repoId]: bumpRepo(r, how, next[r.repoId] ?? {}) };
    setEdits(next);
  };
  const editField = (repo: RepoVersions, f: Field, value: string) => {
    const next = { ...editsOf(repo.repoId) };
    if (value === f.value) delete next[f.id];
    else next[f.id] = value;
    setEdit(repo.repoId, next);
  };
  const [setAllText, setSetAllText] = createSignal<Record<string, string>>({});

  // The exact diff of what is pending, re-read a moment after the last edit.
  let timer: number | undefined;
  let seq = 0;
  createEffect(() => {
    const repoList = data();
    const e = edits();
    window.clearTimeout(timer);
    const mine = ++seq;
    timer = window.setTimeout(async () => {
      const next: Record<string, FilePlan[]> = {};
      const errs: Record<string, string> = {};
      for (const r of repoList) {
        const ch = changesOf(r, e[r.repoId] ?? {});
        if (!ch.length || ch.some((c) => !validValue(r.fields.find((f) => f.id === c.id)!, c.to))) continue;
        try {
          next[r.repoId] = await versionsApi().plan(r.repoId, ch);
        } catch (err) {
          errs[r.repoId] = errorText(err);
        }
      }
      if (mine === seq) (setDiffs(next), setPlanErrors(errs));
    }, 120);
  });
  onCleanup(() => window.clearTimeout(timer));

  async function apply() {
    if (applying() || !total() || hasInvalid()) return;
    setApplying(true);
    setApplyErrors({});
    try {
      for (const r of touched()) {
        try {
          const files = await versionsApi().apply(r.repoId, changesOf(r, editsOf(r.repoId)));
          clearRepo(r.repoId);
          toast.success(t("versions.toast.updated", { repo: nameOf(r.repoId) }), fmt.list(files));
        } catch (err) {
          setApplyErrors({ ...applyErrors(), [r.repoId]: errorText(err) });
          toast.error(t("versions.toast.failed", { repo: nameOf(r.repoId) }), errorText(err));
        }
      }
    } finally {
      setApplying(false);
      await load();
    }
  }

  return (
    <div class="ver" data-testid="versions-tab">
      <header class="ver__bar">
        <Icon icon={Hash} size={16} />
        <h2 class="ver__title">{t("versions.name")}</h2>
        <Show when={withFiles().length > 1}>
          <span class="ver__all" role="group" aria-label={t("versions.all")}>
            <span class="ver__hint">{t("versions.all")}</span>
            <For each={BUMPS}>
              {(b) => (
                <Button size="sm" variant="secondary" aria-label={`${t("versions.all")}: ${t(b.key)}`} onClick={() => bumpEvery(b.how)}>
                  {t(b.key)}
                </Button>
              )}
            </For>
          </span>
        </Show>
        <span class="ver__spacer" />
        <IconButton icon={RefreshCw} label={t("versions.refresh")} size="sm" loading={loading()} onClick={() => void load()} />
      </header>

      <Show when={error()}>
        <p class="ver__error" role="alert">
          {error()}
        </p>
      </Show>

      <Show
        when={loaded()}
        fallback={
          <div class="ver__loading">
            <Skeleton height={22} />
            <Skeleton height={22} />
            <Skeleton height={22} />
          </div>
        }
      >
        <Show when={data().length} fallback={<EmptyState icon={Hash} size="sm" title={t("versions.noRepo")} description={t("versions.noRepoDesc")} />}>
          <For each={withFiles()}>
            {(repo) => {
              const cfg = () => repoConfig(repo.repoId);
              const values = () => versionValues(repo);
              const pending = () => changesOf(repo, editsOf(repo.repoId)).length;
              return (
                <section class="ver__repo" aria-label={nameOf(repo.repoId)} data-testid={`versions-repo-${repo.repoId}`}>
                  <header class="ver__rhead">
                    <Show when={cfg()}>{(c) => <RepoBadge color={c().color} badge={c().badge} size={20} />}</Show>
                    <h3 class="ver__name">{nameOf(repo.repoId)}</h3>
                    <Show when={values().length === 1} fallback={<Show when={values().length > 1}><Badge size="sm" tone="warn">{t("versions.drift", { count: values().length })}</Badge></Show>}>
                      <code class="ver__current" title={t("versions.sync")}>{values()[0]}</code>
                    </Show>
                    <span class="ver__spacer" />
                    <For each={BUMPS}>
                      {(b) => (
                        <Button size="sm" variant="ghost" aria-label={`${nameOf(repo.repoId)}: ${t(b.key)}`} onClick={() => bumpOne(repo, b.how)}>
                          {t(b.key)}
                        </Button>
                      )}
                    </For>
                    <Show when={pending() > 0}>
                      <IconButton icon={RotateCcw} label={t("versions.revert", { name: nameOf(repo.repoId) })} size="sm" onClick={() => clearRepo(repo.repoId)} />
                    </Show>
                  </header>

                  <div class="ver__files">
                    <For each={byFile(repo)}>
                      {(file) => (
                        <div class="ver__file">
                          <div class="ver__fhead">
                            <code class="ver__path">{file.path}</code>
                            <Show when={t(KIND_LABEL[file.kind]) !== file.path.split("/").pop()}>
                              <Badge size="sm">{t(KIND_LABEL[file.kind])}</Badge>
                            </Show>
                          </div>
                          <For each={file.fields}>
                            {(f) => {
                              const shown = () => editsOf(repo.repoId)[f.id] ?? f.value;
                              return (
                                <div class="ver__row" data-changed={shown() !== f.value ? "" : undefined}>
                                  <span class="ver__key">
                                    {f.key}
                                    <Show when={f.role === "build"}>
                                      <Badge size="sm" tone="info">{t("versions.role.build")}</Badge>
                                    </Show>
                                  </span>
                                  <code class="ver__from">{f.value}</code>
                                  <span aria-hidden="true">→</span>
                                  <Input
                                    size="sm"
                                    class="ver__input"
                                    wrapperClass="ver__field"
                                    aria-label={`${nameOf(repo.repoId)} ${f.path} ${f.key}`}
                                    value={shown()}
                                    invalid={invalid(repo.repoId, f)}
                                    spellcheck={false}
                                    onInput={(e) => editField(repo, f, e.currentTarget.value)}
                                  />
                                  <span class="ver__notes">
                                    <Show when={f.mixed}>
                                      <Badge size="sm" tone="warn" title={t("versions.mixedTip")}>{t("versions.mixed", { count: f.occurrences })}</Badge>
                                    </Show>
                                    <Show when={!f.mixed && f.occurrences > 1}>
                                      <span class="ver__hint">{t("versions.places", { count: f.occurrences })}</span>
                                    </Show>
                                    <Show when={f.companions.length}>
                                      <span class="ver__hint">{t("versions.also", { files: fmt.list(f.companions) })}</span>
                                    </Show>
                                    <Show when={isPlaceholder(f)}>
                                      <span class="ver__hint">{t("versions.placeholder")}</span>
                                    </Show>
                                    <Show when={f.kind === "cargo"}>
                                      <span class="ver__hint">{t("versions.cargoNote")}</span>
                                    </Show>
                                  </span>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>

                  <div class="ver__setall">
                    <Input
                      size="sm"
                      wrapperClass="ver__setfield"
                      aria-label={t("versions.setAllAria", { name: nameOf(repo.repoId) })}
                      placeholder={t("versions.setAllPlaceholder")}
                      value={setAllText()[repo.repoId] ?? ""}
                      spellcheck={false}
                      onInput={(e) => setSetAllText({ ...setAllText(), [repo.repoId]: e.currentTarget.value })}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!(setAllText()[repo.repoId] ?? "").trim()}
                      aria-label={t("versions.setAllBtnAria", { name: nameOf(repo.repoId) })}
                      onClick={() => setEdit(repo.repoId, setAllVersions(repo, (setAllText()[repo.repoId] ?? "").trim(), editsOf(repo.repoId)))}
                    >
                      {t("versions.setAllBtn")}
                    </Button>
                  </div>

                  <Show when={repo.truncated}>
                    <p class="ver__note"><Icon icon={TriangleAlert} size={12} /> {t("versions.truncated")}</p>
                  </Show>
                  <For each={repo.skipped}>
                    {(s) => <p class="ver__note"><Icon icon={TriangleAlert} size={12} /> {s}</p>}
                  </For>
                </section>
              );
            }}
          </For>

          <Show when={withoutFiles().length}>
            <p class="ver__hint ver__none">{t("versions.noFiles", { names: fmt.list(withoutFiles().map((r) => nameOf(r.repoId))) })}</p>
          </Show>

          <Show when={Object.keys({ ...planErrors(), ...applyErrors() }).length}>
            <For each={Object.entries({ ...planErrors(), ...applyErrors() })}>
              {([id, message]) => (
                <p class="ver__error" role="alert">
                  {nameOf(id)}: {message}
                </p>
              )}
            </For>
          </Show>

          <Show when={Object.keys(diffs()).length}>
            <section class="ver__diff" aria-label={t("versions.willChange")}>
              <h3 class="ver__h">
                <Icon icon={FileDiff} size={14} /> {t("versions.willChange")}
              </h3>
              <For each={Object.entries(diffs())}>
                {([id, files]) => (
                  <div class="ver__diffrepo">
                    <h4 class="ver__dh">{nameOf(id)}</h4>
                    <For each={files}>{(f) => <pre class="ver__pre" data-path={f.path}>{f.diff}</pre>}</For>
                  </div>
                )}
              </For>
            </section>
          </Show>

          <footer class="ver__foot">
            <span class="ver__hint">{total() ? t("versions.pending", { changes: total(), repos: touched().length }) : t("versions.noCommit")}</span>
            <span class="ver__spacer" />
            <Button variant="primary" size="sm" icon={Check} loading={applying()} disabled={!total() || hasInvalid()} onClick={() => void apply()}>
              {t("versions.apply", { count: total() })}
            </Button>
          </footer>
        </Show>
      </Show>
    </div>
  );
}
