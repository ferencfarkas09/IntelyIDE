import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Trackable } from "../../ipc/happy";
import { Button, Input, Select } from "../../ui-kit";
import { createErrorKey } from "./logic";
import "./timer.css";

export interface NewTaskProps {
  /** The project to add to. Without it the person picks one of `projects`. */
  projectId?: string;
  projectTitle?: string;
  projects: { id: string; title: string }[];
  initialTitle?: string;
  /** The created task, ready to start. */
  onCreated: (task: Trackable) => void;
  onCancel: () => void;
}

/** A small inline form: a title (and a project when none is fixed), Enter creates, Escape cancels. */
export function NewTask(props: NewTaskProps) {
  const [title, setTitle] = createSignal(props.initialTitle ?? "");
  const [project, setProject] = createSignal(props.projectId ?? (props.projects.length === 1 ? props.projects[0].id : ""));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const ready = () => title().trim().length > 0 && project() !== "";

  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (busy() || !ready()) return;
    setBusy(true);
    setError(undefined);
    try {
      props.onCreated(await ipc.happy.timer.createTask(project(), title().trim()));
    } catch (err) {
      setError(t(createErrorKey(typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : undefined)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="ht__new" aria-label={props.projectTitle ? t("htm.new.in", { project: props.projectTitle }) : t("htm.new.form")} onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); props.onCancel(); } }}>
      <Show when={props.projectTitle}>{(name) => <span class="ht__new-for ui-truncate">{t("htm.new.in", { project: name() })}</span>}</Show>
      <Show when={!props.projectId}>
        <Select size="sm" aria-label={t("htm.new.project")} placeholder={t("htm.new.pickProject")} value={project() || undefined} options={props.projects.map((p) => ({ value: p.id, label: p.title }))} onChange={setProject} />
      </Show>
      <Input
        size="sm"
        ref={(el: HTMLInputElement) => queueMicrotask(() => el.focus())}
        value={title()}
        maxLength={200}
        placeholder={t("htm.new.title")}
        aria-label={t("htm.new.title")}
        invalid={!!error()}
        onInput={(e) => { setTitle(e.currentTarget.value); setError(undefined); }}
      />
      <Show when={error()}>{(msg) => <p class="ht__new-error" role="alert">{msg()}</p>}</Show>
      <span class="ht__new-actions">
        <Button type="submit" size="sm" variant="primary" loading={busy()} disabled={!ready()}>{t("htm.new.create")}</Button>
        <Button size="sm" variant="ghost" disabled={busy()} onClick={props.onCancel}>{t("htm.cancel")}</Button>
      </span>
    </form>
  );
}
