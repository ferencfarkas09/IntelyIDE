import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { tasksView } from "../../store/happyNt";
import { repos } from "../../store/workspace";
import { Button, FormGroup, FormRow, Input, Select } from "../../ui-kit";
import { branchName, DEFAULT_BRANCH_TEMPLATE } from "./logic";
import { loadTaskPrefs, saveTaskPrefs, taskPrefs } from "./prefs";
import "./tasks.css";

/** Sample data for the template preview, not UI text. */
const SAMPLE = { id: "t_receipts", key: "HP-142", title: "Receipts: print the VAT line", project: "Shop POS" }; // i18n-ignore

/** Settings > Tasks: the branch name template and which repository each Happy project belongs to. */
export default function TasksSettings() {
  onMount(loadTaskPrefs);
  const [draft, setDraft] = createSignal(taskPrefs().branchTemplate);
  createEffect(on(() => taskPrefs().branchTemplate, (v) => setDraft(v)));
  const commit = () => void saveTaskPrefs({ branchTemplate: draft().trim() || DEFAULT_BRANCH_TEMPLATE });
  const projects = createMemo(() => [...new Set([...tasksView().tasks.flatMap((task) => (task.project ? [task.project] : [])), ...Object.keys(taskPrefs().repoMap)])].sort((a, b) => a.localeCompare(b)));
  const options = () => [{ value: "", label: t("ht.set.auto") }, ...repos().map((r) => ({ value: r.name, label: r.name }))];
  const setMapping = (project: string, repo: string) => {
    const next = { ...taskPrefs().repoMap };
    if (repo) next[project] = repo;
    else delete next[project];
    void saveTaskPrefs({ repoMap: next });
  };

  return (
    <div class="tks">
      <FormGroup title={t("ht.set.branches")} description={t("ht.set.branchesDesc")}>
        <FormRow
          label={t("ht.set.template")}
          labelFor="tasks-branch-template"
          stacked
          description={
            <>
              <span class="tks__tokens">{t("ht.set.tokens", { tKey: "{key}", tId: "{id}", tSlug: "{slug}", tProject: "{project}" })}</span>
              <code class="tks__preview" aria-label={t("ht.set.preview")}>{branchName(draft(), SAMPLE)}</code>
            </>
          }
        >
          <div class="tks__map">
            <Input id="tasks-branch-template" size="sm" wrapperClass="int__wide" value={draft()} spellcheck={false} autocomplete="off" placeholder={DEFAULT_BRANCH_TEMPLATE} onInput={(e) => setDraft(e.currentTarget.value)} onChange={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
            <Button size="sm" variant="ghost" disabled={draft() === DEFAULT_BRANCH_TEMPLATE} onClick={() => { setDraft(DEFAULT_BRANCH_TEMPLATE); commit(); }}>{t("ht.set.reset")}</Button>
          </div>
        </FormRow>
      </FormGroup>
      <FormGroup title={t("ht.set.map")} description={t("ht.set.mapDesc")}>
        <Show when={projects().length} fallback={<p class="tks__note">{t("ht.set.empty")}</p>}>
          <For each={projects()}>
            {(project) => (
              <FormRow label={project}>
                <Select size="sm" aria-label={t("ht.set.repoFor", { project })} options={options()} value={taskPrefs().repoMap[project] ?? ""} onChange={(repo) => setMapping(project, repo)} />
              </FormRow>
            )}
          </For>
        </Show>
      </FormGroup>
    </div>
  );
}
