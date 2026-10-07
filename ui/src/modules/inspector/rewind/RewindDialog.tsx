import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t } from "../../../i18n";
import { ipc as defaultIpc, type Ipc } from "../../../ipc";
import type { RewindPreview, RewindResult, RewindSnapshot } from "../../../ipc/runs";
import { relativeTime } from "../format";
import { repoConfig } from "../../../store/workspace";
import { Badge, Button, CircleAlert, CircleCheck, Dialog, EmptyState, Input, RepoBadge, Skeleton, Spinner } from "../../../ui-kit";
import { changeText, confirmPhrase, groupByRepo, restoreGate } from "./logic";

const message = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));

export interface RewindDialogProps {
  open: boolean;
  onClose: () => void;
  runId: string;
  /** A run that is still working cannot be rewound. */
  runActive: boolean;
  client?: Ipc;
  /** Called after a successful restore so the Changes tree can refresh. */
  onRestored?: (result: RewindResult) => void;
}

/** Rewind: snapshots of the run, a dry-run list of the files that would change, a typed confirmation, then the restore. */
export function RewindDialog(props: RewindDialogProps) {
  const client = () => props.client ?? defaultIpc;
  const [snapshots, setSnapshots] = createSignal<RewindSnapshot[] | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const [preview, setPreview] = createSignal<RewindPreview | undefined>(undefined);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<RewindResult | undefined>(undefined);

  const snapshot = () => snapshots()?.find((s) => s.id === picked());
  const repoName = (id: string) => repoConfig(id)?.name ?? id;
  const phrase = () => confirmPhrase(snapshot() ? repoName(snapshot()!.repoId) : "");
  /** The confirmation sentence around the phrase, which is rendered in bold between the two halves. */
  const typeParts = () => t("inspector.rewind.type", { phrase: "\u0001" }).split("\u0001");
  const gate = () => restoreGate({ runActive: props.runActive, snapshotId: picked(), fileCount: preview()?.files.length, typed: typed(), phrase: phrase(), busy: busy() });

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setSnapshots(undefined);
        setPicked(undefined);
        setPreview(undefined);
        setTyped("");
        setError(undefined);
        setResult(undefined);
        client()
          .runs.rewindSnapshots(props.runId)
          .then((list) => {
            setSnapshots(list);
            if (list.length === 1) setPicked(list[0].id);
          })
          .catch((e) => (setError(message(e)), setSnapshots([])));
      },
    ),
  );

  createEffect(
    on(picked, (id) => {
      setPreview(undefined);
      setTyped("");
      if (!id) return;
      client()
        .runs.rewindPreview(props.runId, id)
        .then((p) => picked() === id && setPreview(p))
        .catch((e) => picked() === id && setError(message(e)));
    }),
  );

  async function restore() {
    const id = picked();
    if (!id || !gate().ok) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await client().runs.rewindRestore(props.runId, { confirm: true, snapshotId: id });
      const done: RewindResult = r ?? { snapshotId: id, restored: preview()?.files ?? [] };
      setResult(done);
      props.onRestored?.(done);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="lg"
      class="rewind"
      title={t("inspector.rewind.title")}
      description={t("inspector.rewind.desc")}
      footer={
        <Show
          when={!result()}
          fallback={
            <Button variant="primary" onClick={props.onClose}>
              {t("inspector.rewind.done")}
            </Button>
          }
        >
          <Button variant="ghost" onClick={props.onClose}>
            {t("inspector.rewind.cancel")}
          </Button>
          <span title={gate().reason}>
            <Button variant="danger" disabled={!gate().ok} loading={busy()} onClick={() => void restore()}>
              {preview()?.files.length ? t("inspector.rewind.restoreN", { n: preview()!.files.length }) : t("inspector.rewind.restore")}
            </Button>
          </span>
        </Show>
      }
    >
      <Show when={!result()} fallback={<RewindResultView result={result()!} repoName={repoName} />}>
        <Show when={error()}>
          <div class="rewind__error" role="alert">
            <CircleAlert size={14} /> {error()}
          </div>
        </Show>
        <Show when={props.runActive}>
          <div class="rewind__warn" role="status">
            {t("inspector.rewind.active")}
          </div>
        </Show>
        <Show when={snapshots()} fallback={<Skeleton width="100%" height={48} />}>
          {(list) => (
            <Show when={list().length > 0} fallback={<EmptyState size="sm" title={t("inspector.rewind.noSnaps")} description={t("inspector.rewind.noSnapsDesc")} />}>
              <div class="rewind__snaps" role="radiogroup" aria-label={t("inspector.rewind.snaps")}>
                <For each={list()}>
                  {(s) => (
                    <button type="button" role="radio" aria-checked={picked() === s.id} class="rewind__snap" onClick={() => setPicked(s.id)}>
                      <Show when={repoConfig(s.repoId)} fallback={<Badge size="sm">{s.repoId}</Badge>}>
                        {(r) => <RepoBadge color={r().color} badge={r().badge} size={20} />}
                      </Show>
                      <span class="rewind__snap-name">{repoName(s.repoId)}</span>
                      <span class="ui-text-3">{s.label}</span>
                      <span class="rewind__snap-time ui-text-3">{relativeTime(s.takenMs, Date.now())}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
        <Show when={picked()}>
          <div class="rewind__files" aria-live="polite">
            <Show when={preview()} fallback={<Skeleton width="100%" height={40} />}>
              {(p) => (
                <Show when={p().files.length > 0} fallback={<div class="rewind__none"><CircleCheck size={14} /> {t("inspector.rewind.nothing")}</div>}>
                  <div class="rewind__dry">{t("inspector.rewind.dry", { n: p().files.length })}</div>
                  <For each={groupByRepo(p().files)}>
                    {(g) => (
                      <ul class="rewind__list" aria-label={t("inspector.rewind.filesIn", { repo: repoName(g.repoId) })}>
                        <For each={g.files}>
                          {(f) => (
                            <li class="rewind__file" data-change={f.change}>
                              <span class="rewind__path ui-truncate" title={f.path}>{f.path}</span>
                              <span class="rewind__change">{changeText(f.change)}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    )}
                  </For>
                  <label class="rewind__confirm">
                    <span>
                      {typeParts()[0]}<strong class="rewind__phrase">{phrase()}</strong>{typeParts()[1]}
                    </span>
                    <Input size="sm" aria-label={t("inspector.rewind.confirmLabel")} autocomplete="off" spellcheck={false} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} invalid={typed().length > 0 && typed() !== phrase()} />
                  </label>
                </Show>
              )}
            </Show>
          </div>
        </Show>
        <Show when={busy()}>
          <div class="rewind__busy"><Spinner size={14} label={t("inspector.rewind.restoring")} /> {t("inspector.rewind.restoringText")}</div>
        </Show>
      </Show>
    </Dialog>
  );
}

function RewindResultView(props: { result: RewindResult; repoName: (id: string) => string }) {
  return (
    <div class="rewind__result" role="status">
      <div class="rewind__ok"><CircleCheck size={16} /> {t("inspector.rewind.restored", { n: props.result.restored.length })}</div>
      <Show when={props.result.restored.length === 0}>
        <p class="ui-text-3">{t("inspector.rewind.matched")}</p>
      </Show>
      <For each={groupByRepo(props.result.restored)}>
        {(g) => (
          <ul class="rewind__list" aria-label={t("inspector.rewind.restoredIn", { repo: props.repoName(g.repoId) })}>
            <For each={g.files}>
              {(f) => (
                <li class="rewind__file" data-change={f.change}>
                  <span class="rewind__path ui-truncate" title={f.path}>{f.path}</span>
                  <span class="rewind__change">{changeText(f.change)}</span>
                </li>
              )}
            </For>
          </ul>
        )}
      </For>
    </div>
  );
}
