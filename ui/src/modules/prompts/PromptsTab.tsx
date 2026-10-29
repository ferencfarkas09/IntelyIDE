import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { requestNewRun } from "../../platform/newRun";
import { errorText } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { Button, Copy, Download, EmptyState, FilePlus, Input, ListChecks, Play, Save, Select, TextArea, toast, Trash2, Upload, type SelectOption } from "../../ui-kit";
import { exportJson, fillPrompt, libraryFor, MAX_BODY, MAX_TITLE, newId, parseImport, parseTags, placeholdersIn, PLACEHOLDERS, upsert } from "./logic";
import { PromptList } from "./PromptList";
import { starterPrompts } from "./starters";
import { currentRepo, loadPrompts, promptContext, promptSettings, promptsOf, savePrompts } from "./store";
import type { PromptScope, SavedPrompt, ScopedPrompt } from "./types";
import "./prompts.css";

const scopeKey = (s: PromptScope): string => (s.kind === "repo" ? `repo:${s.repoId}` : s.kind);
const scopeOf = (key: string): PromptScope => (key.startsWith("repo:") ? { kind: "repo", repoId: key.slice(5) } : { kind: "user" });

interface Draft {
  /** undefined: a new prompt. */
  id?: string;
  from?: PromptScope;
  scope: string;
  title: string;
  tags: string;
  body: string;
  readOnly: boolean;
}

const emptyDraft = (): Draft => ({ scope: "user", title: "", tags: "", body: "", readOnly: false });

/** The prompt library: the starters and the person's own prompts, edited here; stored in settings.json, never in a repository. */
export default function PromptsTab() {
  const [draft, setDraft] = createSignal<Draft>(emptyDraft());
  const [saving, setSaving] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  onMount(() => void loadPrompts());
  const library = createMemo(() => libraryFor(promptSettings(), Object.keys(promptSettings().repos), starterPrompts()));
  const scopes = createMemo((): SelectOption<string>[] => [{ value: "user", label: t("prompts.scope.user") }, ...repos().map((r) => ({ value: `repo:${r.id}`, label: t("prompts.scope.repo", { repo: r.name }) }))]);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const valid = () => draft().title.trim().length > 0 && draft().body.trim().length > 0;
  const unknown = createMemo(() => [...draft().body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]).filter((n) => !(PLACEHOLDERS as readonly string[]).includes(n.toLowerCase())));

  const select = (p: ScopedPrompt) => {
    setConfirmDelete(false);
    setDraft({ id: p.id, from: p.scope, scope: p.scope.kind === "starter" ? "user" : scopeKey(p.scope), title: p.title, tags: p.tags.join(", "), body: p.body, readOnly: p.scope.kind === "starter" });
  };

  const save = async () => {
    const d = draft();
    if (!valid() || d.readOnly) return;
    setSaving(true);
    try {
      const target = scopeOf(d.scope);
      const prompt: SavedPrompt = { id: d.id ?? newId(), title: d.title.trim().slice(0, MAX_TITLE), body: d.body.slice(0, MAX_BODY), tags: parseTags(d.tags), updatedAt: Date.now() };
      // moved to another scope: out of the old list first
      if (d.from && d.from.kind !== "starter" && scopeKey(d.from) !== d.scope) await savePrompts(d.from, promptsOf(d.from).filter((x) => x.id !== prompt.id));
      await savePrompts(target, upsert(promptsOf(target), prompt));
      setDraft({ ...d, id: prompt.id, from: target });
      toast.success(t("prompts.saved"));
    } catch (e) {
      toast.error(t("prompts.saveFailed"), errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const d = draft();
    if (!d.id || !d.from || d.from.kind === "starter") return;
    if (!confirmDelete()) return void setConfirmDelete(true);
    try {
      await savePrompts(d.from, promptsOf(d.from).filter((x) => x.id !== d.id));
      setDraft(emptyDraft());
      setConfirmDelete(false);
    } catch (e) {
      toast.error(t("prompts.saveFailed"), errorText(e));
    }
  };

  const copyToMine = () => patch({ id: undefined, from: undefined, readOnly: false, scope: "user", title: t("prompts.copyTitle", { title: draft().title }) });

  const useNow = async () => {
    const d = draft();
    const scope = scopeOf(d.scope);
    const repo = scope.kind === "repo" ? scope.repoId : currentRepo();
    const prompt = fillPrompt(d.body, await promptContext(repo));
    if (!(await requestNewRun({ prompt, repoIds: repo ? [repo] : undefined }))) toast.warn(t("prompts.noDialog"));
  };

  const own = () => [...promptSettings().user, ...Object.values(promptSettings().repos).flat()];
  const exportAll = async () => {
    const text = exportJson(own());
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("prompts.exported", { n: own().length }));
    } catch {
      toast.error(t("prompts.exportFailed"));
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return void toast.error(t("prompts.import.tooBig"));
    const parsed = parseImport(await file.text());
    if ("error" in parsed) return void toast.error(t(`prompts.import.${parsed.error}`));
    const target = scopeOf(draft().scope);
    try {
      await savePrompts(target, [...parsed.prompts, ...promptsOf(target)]);
      toast.success(t("prompts.imported", { n: parsed.prompts.length, skipped: parsed.skipped }));
    } catch (e) {
      toast.error(t("prompts.saveFailed"), errorText(e));
    }
  };

  return (
    <div class="prompts-tab">
      <div class="prompts-tab__grid">
        <aside class="prompts-tab__side">
          <div class="prompts-tab__actions">
            <Button size="sm" icon={FilePlus} onClick={() => (setConfirmDelete(false), setDraft(emptyDraft()))}>{t("prompts.new")}</Button>
            <Button size="sm" variant="ghost" icon={Upload} onClick={() => fileInput?.click()} title={t("prompts.importTip")}>{t("prompts.import")}</Button>
            <Button size="sm" variant="ghost" icon={Download} disabled={own().length === 0} onClick={() => void exportAll()} title={t("prompts.exportTip")}>{t("prompts.export")}</Button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => (void importFile(e.currentTarget.files?.[0]), (e.currentTarget.value = ""))} />
          </div>
          <PromptList prompts={library()} selected={draft().id} onPick={select} />
        </aside>
        <section class="prompts-tab__edit" aria-label={t("prompts.editor")}>
          <Show when={draft().readOnly}>
            <p class="prompts-tab__note" role="status">
              {t("prompts.starterNote")} <Button size="sm" variant="secondary" icon={Copy} onClick={copyToMine}>{t("prompts.copy")}</Button>
            </p>
          </Show>
          <label class="prompts-tab__field">
            <span class="prompts-tab__label">{t("prompts.field.title")}</span>
            <Input size="sm" value={draft().title} maxLength={MAX_TITLE} readOnly={draft().readOnly} onInput={(e) => patch({ title: e.currentTarget.value })} />
          </label>
          <div class="prompts-tab__row">
            <label class="prompts-tab__field">
              <span class="prompts-tab__label">{t("prompts.field.scope")}</span>
              <Select size="sm" aria-label={t("prompts.field.scope")} options={scopes()} value={draft().scope} disabled={draft().readOnly} onChange={(v) => patch({ scope: v })} />
            </label>
            <label class="prompts-tab__field">
              <span class="prompts-tab__label">{t("prompts.field.tags")}</span>
              <Input size="sm" value={draft().tags} placeholder={t("prompts.field.tagsHint")} readOnly={draft().readOnly} onInput={(e) => patch({ tags: e.currentTarget.value })} />
            </label>
          </div>
          <label class="prompts-tab__field">
            <span class="prompts-tab__label">{t("prompts.field.body")}</span>
            <TextArea class="ui-mono" minRows={8} maxRows={22} value={draft().body} maxLength={MAX_BODY} readOnly={draft().readOnly} onInput={(e) => patch({ body: e.currentTarget.value })} />
          </label>
          <p class="prompts-tab__hint">
            {t("prompts.placeholders")}{" "}
            <For each={PLACEHOLDERS}>{(p) => <code class={placeholdersIn(draft().body).includes(p) ? "prompts-tab__ph prompts-tab__ph--used" : "prompts-tab__ph"}>{`{{${p}}}`}</code>}</For>
          </p>
          <Show when={unknown().length > 0}>
            <p class="prompts-tab__warn" role="status">{t("prompts.unknownPlaceholder", { names: unknown().join(", ") })}</p>
          </Show>
          <div class="prompts-tab__buttons">
            <Show when={!draft().readOnly}>
              <Button size="sm" icon={Save} loading={saving()} disabled={!valid()} onClick={() => void save()}>{t("prompts.save")}</Button>
            </Show>
            <Button size="sm" variant="secondary" icon={Play} disabled={!draft().body.trim()} onClick={() => void useNow()}>{t("prompts.use")}</Button>
            <Show when={draft().id && !draft().readOnly}>
              <Button size="sm" variant={confirmDelete() ? "danger" : "ghost"} icon={Trash2} onClick={() => void remove()}>{confirmDelete() ? t("prompts.deleteConfirm") : t("prompts.delete")}</Button>
            </Show>
          </div>
          <Show when={!draft().title && !draft().body}>
            <EmptyState size="sm" icon={ListChecks} title={t("prompts.emptyTitle")} description={t("prompts.emptyDesc")} />
          </Show>
        </section>
      </div>
    </div>
  );
}
