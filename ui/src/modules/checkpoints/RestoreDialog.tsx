import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import type { RewindFile } from "../../ipc/runs";
import { agentRow } from "../../store/agents";
import { repoConfig } from "../../store/workspace";
import { Button, Checkbox, CircleAlert, CircleCheck, Dialog, Input, Skeleton, Spinner } from "../../ui-kit";
import { checkpointsApi } from "./api";
import { conflictCount, errorText, planFiles, restoreGate, restorePhrase, touchedCount } from "./logic";
import { checkpointsChanged } from "./store";
import type { ConfigCopy, RepoPlan, RepoRestore } from "./types";
import "./checkpoints.css";

const CHANGE_KEY = { modified: "checkpoints.change.modified", created: "checkpoints.change.created", deleted: "checkpoints.change.deleted" } as const satisfies Record<RewindFile["change"], MessageKey>;

export interface RestoreDialogProps {
  open: boolean;
  onClose: () => void;
  runId: string;
  seq: number;
  /** Shown in the title: "Undo last step" or "Restore to this point". */
  mode: "undo" | "pick";
  /** The step's name, for the description. */
  stepName?: string;
}

/**
 * Restore to a checkpoint, the Rewind way: a dry-run list first, then the typed confirmation. Files edited after the newest
 * checkpoint are listed apart and kept unless the person ticks the box; protected config files come back only when ticked one by one.
 */
export function RestoreDialog(props: RestoreDialogProps) {
  const api = () => checkpointsApi();
  const [plans, setPlans] = createSignal<RepoPlan[] | undefined>(undefined);
  const [copies, setCopies] = createSignal<ConfigCopy[]>([]);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [typed, setTyped] = createSignal("");
  const [overwrite, setOverwrite] = createSignal(false);
  const [configPicked, setConfigPicked] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ repos: RepoRestore[]; config: string[] } | undefined>(undefined);

  const row = () => agentRow(props.runId);
  const runActive = () => row()?.status === "running" || row()?.status === "needsYou";
  const repoName = (id: string) => repoConfig(id)?.name ?? id;
  const phrase = () => restorePhrase((plans() ?? []).map((p) => repoName(p.repoId)));
  const files = () => (plans() ? planFiles(plans()!) : undefined);
  const conflicts = () => new Set((plans() ?? []).flatMap((p) => p.conflicts.map((c) => `${p.repoId}\u0000${c}`)));
  const isConflict = (f: RewindFile) => conflicts().has(`${f.repoId}\u0000${f.path}`);
  const writes = () => (plans() ? touchedCount(plans()!, overwrite()) + configPicked().length : undefined);
  const gate = () => restoreGate({ runActive: runActive(), files: writes(), typed: typed(), phrase: phrase(), busy: busy() });
  const typeParts = () => t("checkpoints.restore.type", { phrase: "\u0001" }).split("\u0001");
  const copyKey = (c: ConfigCopy) => `${c.repoId}\u0000${c.path}`;

  createEffect(
    on(
      () => [props.open, props.runId, props.seq] as const,
      ([open]) => {
        if (!open) return;
        setPlans(undefined);
        setCopies([]);
        setError(undefined);
        setTyped("");
        setOverwrite(false);
        setConfigPicked([]);
        setResult(undefined);
        const runId = props.runId;
        const seq = props.seq;
        api()
          .plan(runId, seq)
          .then((p) => runId === props.runId && seq === props.seq && setPlans(p))
          .catch((e) => (setError(errorText(e)), setPlans([])));
        api()
          .config(runId, seq)
          .then((c) => runId === props.runId && setCopies(c.filter((x) => x.state !== "same")))
          .catch(() => setCopies([]));
      },
    ),
  );

  async function restore() {
    if (!gate().ok) return;
    setBusy(true);
    setError(undefined);
    try {
      const repos = await api().restore(props.runId, props.seq, { confirm: true, overwriteConflicts: overwrite() });
      const config: string[] = [];
      for (const repoId of new Set(copies().map((c) => c.repoId))) {
        const paths = copies().filter((c) => c.repoId === repoId && configPicked().includes(copyKey(c))).map((c) => c.path);
        if (paths.length) config.push(...(await api().restoreConfig(props.runId, props.seq, repoId, paths, true)));
      }
      setResult({ repos, config });
      checkpointsChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="lg"
      class="cp-restore"
      title={props.mode === "undo" ? t("checkpoints.undo.title") : t("checkpoints.restore.title")}
      description={props.stepName ? t("checkpoints.restore.descNamed", { name: props.stepName }) : t("checkpoints.restore.desc")}
      footer={
        <Show
          when={!result()}
          fallback={
            <Button variant="primary" onClick={props.onClose}>
              {t("checkpoints.restore.done")}
            </Button>
          }
        >
          <Button variant="ghost" onClick={props.onClose}>
            {t("checkpoints.restore.cancel")}
          </Button>
          <span title={gate().reason}>
            <Button variant="danger" disabled={!gate().ok} loading={busy()} onClick={() => void restore()}>
              {writes() ? t("checkpoints.restore.restoreN", { n: writes()! }) : t("checkpoints.restore.restore")}
            </Button>
          </span>
        </Show>
      }
    >
      <Show when={!result()} fallback={<RestoreResult result={result()!} repoName={repoName} />}>
        <Show when={error()}>
          <div class="cp-restore__error" role="alert">
            <CircleAlert size={14} /> {error()}
          </div>
        </Show>
        <Show when={runActive()}>
          <div class="cp-restore__warn" role="status">
            {t("checkpoints.restore.active")}
          </div>
        </Show>
        <Show when={files()} fallback={<Skeleton width="100%" height={48} />}>
          {(list) => (
            <Show when={list().length > 0 || copies().length > 0} fallback={<div class="cp-restore__none"><CircleCheck size={14} /> {t("checkpoints.restore.nothing")}</div>}>
              <Show when={list().length > 0}>
                <div class="cp-restore__dry">{t("checkpoints.restore.dry", { n: list().length })}</div>
                <For each={plans()}>
                  {(p) => (
                    <Show when={planFiles([p]).length > 0}>
                      <ul class="cp-restore__list" aria-label={t("checkpoints.restore.filesIn", { repo: repoName(p.repoId) })}>
                        <For each={planFiles([p])}>
                          {(f) => (
                            <li class="cp-restore__file" data-change={f.change} data-conflict={isConflict(f) ? "" : undefined}>
                              <span class="cp-restore__path ui-truncate" title={f.path}>{f.path}</span>
                              <span class="cp-restore__change">{isConflict(f) && !overwrite() ? t("checkpoints.change.kept") : t(CHANGE_KEY[f.change])}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                      <Show when={p.headChanged}>
                        <p class="cp-restore__note">{t("checkpoints.restore.headChanged", { repo: repoName(p.repoId) })}</p>
                      </Show>
                    </Show>
                  )}
                </For>
              </Show>
              <Show when={plans() && conflictCount(plans()!) > 0}>
                <div class="cp-restore__warn" role="note" data-testid="cp-conflicts">
                  <span>{t("checkpoints.restore.conflicts", { n: conflictCount(plans()!) })}</span>
                  <Checkbox checked={overwrite()} onChange={setOverwrite} label={t("checkpoints.restore.overwrite", { n: conflictCount(plans()!) })} />
                </div>
              </Show>
              <Show when={copies().length > 0}>
                <fieldset class="cp-restore__config">
                  <legend>{t("checkpoints.restore.configTitle")}</legend>
                  <p class="ui-text-3">{t("checkpoints.restore.configDesc")}</p>
                  <For each={copies()}>
                    {(c) => (
                      <Checkbox
                        checked={configPicked().includes(copyKey(c))}
                        onChange={(on) => setConfigPicked((all) => (on ? [...all, copyKey(c)] : all.filter((k) => k !== copyKey(c))))}
                        label={t(c.state === "missing" ? "checkpoints.restore.configMissing" : "checkpoints.restore.configDiffers", { path: c.path, repo: repoName(c.repoId) })}
                      />
                    )}
                  </For>
                </fieldset>
              </Show>
              <label class="cp-restore__confirm">
                <span>
                  {typeParts()[0]}<strong class="cp-restore__phrase">{phrase()}</strong>{typeParts()[1]}
                </span>
                <Input size="sm" aria-label={t("checkpoints.restore.confirmLabel")} autocomplete="off" spellcheck={false} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} invalid={typed().length > 0 && typed() !== phrase()} />
              </label>
            </Show>
          )}
        </Show>
        <Show when={busy()}>
          <div class="cp-restore__busy"><Spinner size={14} label={t("checkpoints.restore.restoring")} /> {t("checkpoints.restore.restoring")}</div>
        </Show>
      </Show>
    </Dialog>
  );
}

function RestoreResult(props: { result: { repos: RepoRestore[]; config: string[] }; repoName: (id: string) => string }) {
  const written = () => props.result.repos.reduce((n, r) => n + r.overwritten.length + r.recreated.length + r.deleted.length, 0);
  const kept = () => props.result.repos.flatMap((r) => r.kept.map((path) => ({ repoId: r.repoId, path })));
  return (
    <div class="cp-restore__result" role="status">
      <div class="cp-restore__ok"><CircleCheck size={16} /> {t("checkpoints.restore.restored", { n: written() })}</div>
      <Show when={props.result.config.length > 0}>
        <p class="ui-text-2">{t("checkpoints.restore.configRestored", { n: props.result.config.length })}</p>
      </Show>
      <Show when={kept().length > 0}>
        <p class="ui-text-2">{t("checkpoints.restore.keptList", { n: kept().length })}</p>
        <ul class="cp-restore__list">
          <For each={kept()}>
            {(k) => (
              <li class="cp-restore__file">
                <span class="cp-restore__path ui-truncate" title={k.path}>{k.path}</span>
                <span class="cp-restore__change">{props.repoName(k.repoId)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="ui-text-3">{t("checkpoints.restore.undoHint")}</p>
    </div>
  );
}
