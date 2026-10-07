import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc, type Hunk } from "../../ipc";
import type { TabInstance } from "../../platform/tabs";
import { clearPartial, hunksSignature, partialHunks, setPartialHunks } from "../../store/partialSelection";
import { canSelect, fileChecked, toggleFile } from "../../store/selection";
import { refreshSnapshots, snapshots } from "../../store/snapshots";
import { Badge, Button, Checkbox, EmptyState, FileDiff, IconButton, Skeleton, toast, Undo2 } from "../../ui-kit";
import { hunkStats, resolveChoice, toggled } from "./hunks";
import { errorMessage } from "./ops";
import { revertHunkInText } from "./revertHunk";
import "./graph.css";

interface HunksParams extends Record<string, unknown> {
  repoId: string;
  path: string;
}

/** Tab type `hunks`: tick the hunks of one file that go into the next commit, or revert a hunk in the working tree. */
export default function HunksTab(props: { tab: TabInstance }) {
  const p = () => props.tab.params as HunksParams;
  const revision = () => snapshots()[p().repoId]?.revision;
  const [hunks, { refetch }] = createResource(
    () => ({ ...p(), revision: revision() }),
    (r) => ipc.fileHunks(r.repoId, r.path, { kind: "worktreeVsHead" }),
  );
  const [selected, setSelected] = createSignal<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const list = (): Hunk[] => hunks.latest ?? [];
  const change = () => snapshots()[p().repoId]?.changes.find((c) => c.path === p().path);

  // Ticks follow what the commit will contain: nothing while the file is unticked, else the stored partial selection or all hunks.
  createEffect(
    on(
      () => [hunks.latest, fileChecked(p().repoId, p().path), partialHunks(p().repoId, p().path)] as const,
      ([loaded, checked, partial]) => {
        if (!loaded) return;
        setSelected(new Set(!checked ? [] : partial ? partial.map((h) => h.index) : loaded.map((h) => h.index)));
      },
    ),
  );

  /** Writes the ticks back: the commit gets the whole file, some hunks or nothing. */
  const apply = (next: ReadonlySet<number>) => {
    const { repoId, path } = p();
    setSelected(next);
    const choice = resolveChoice(next, list().length);
    if (choice.kind === "some") {
      setPartialHunks(repoId, path, choice.indexes, hunksSignature(list()));
      if (!fileChecked(repoId, path) && canSelect(repoId, path)) toggleFile(repoId, path);
    } else {
      clearPartial(repoId, path);
      if ((choice.kind === "whole") !== fileChecked(repoId, path) && canSelect(repoId, path)) toggleFile(repoId, path);
    }
  };

  const revert = async (index: number) => {
    setBusy(true);
    try {
      // The engine has no hunk-level discard: the hunk is undone in the file text and written back, refused if the file moved on.
      const hunk = list().find((h) => h.index === index);
      const file = await ipc.files.readFile(p().repoId, p().path);
      if (!hunk || file.text === undefined) throw { code: "staleFile", message: t("graph.hunks.cannotEdit") };
      await ipc.files.writeFile(p().repoId, p().path, revertHunkInText(file.text, hunk), file.mtimeMs, { encoding: file.encoding });
      clearPartial(p().repoId, p().path);
      setConfirming(null);
      toast.success(t("graph.hunks.reverted"), t("graph.hunks.revertedBody"));
      await Promise.all([refreshSnapshots(p().repoId), refetch()]);
    } catch (err) {
      toast.error(t("graph.hunks.revertFail"), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const count = () => selected().size;
  const editable = () => !!change() && change()!.kind === "modified" && canSelect(p().repoId, p().path);

  return (
    <section class="ghunks" aria-label={t("graph.hunks.label", { path: p().path })}>
      <header class="ghunks__head">
        <span class="ghunks__path ui-truncate" title={p().path}>{p().path}</span>
        <Badge size="sm" tone={count() === list().length ? "ok" : "accent"} numeric>
          {t("graph.hunks.summary", { count: count(), total: list().length })}
        </Badge>
        <span class="ghunks__grow" />
        <Button size="sm" variant="ghost" disabled={!editable() || count() === list().length} onClick={() => apply(new Set(list().map((h) => h.index)))}>{t("graph.hunks.all")}</Button>
        <Button size="sm" variant="ghost" disabled={!editable() || count() === 0} onClick={() => apply(new Set())}>{t("graph.hunks.none")}</Button>
      </header>
      <div class="ghunks__list">
        <Show when={!hunks.error} fallback={<EmptyState tone="danger" size="sm" icon={FileDiff} title={t("graph.hunks.failed")} description={errorMessage(hunks.error)} action={<Button size="sm" onClick={() => void refetch()}>{t("graph.retry")}</Button>} />}>
          <Show when={hunks.latest} fallback={<div class="ghunks__loading" aria-busy="true"><Skeleton height={14} width="60%" /><Skeleton height={14} width="80%" /><Skeleton height={14} width="45%" /></div>}>
            <Show when={list().length > 0} fallback={<EmptyState size="sm" icon={FileDiff} title={t("graph.hunks.empty")} description={t("graph.hunks.emptyDesc")} />}>
              <Show when={!editable()}>
                <p class="ghunks__note">{t("graph.hunks.note")}</p>
              </Show>
              <For each={list()}>
                {(hunk) => {
                  const stats = hunkStats(hunk.lines);
                  return (
                    <article class="ghunk" data-included={selected().has(hunk.index) ? "" : undefined}>
                      <header class="ghunk__head">
                        <Checkbox size="sm" aria-label={t("graph.hunks.include", { n: hunk.index + 1 })} disabled={!editable() || busy()} checked={selected().has(hunk.index)} onChange={() => apply(toggled(selected(), hunk.index))} />
                        <code class="ghunk__header ui-mono ui-truncate" title={hunk.header}>{hunk.header}</code>
                        <span class="ghunk__stats ui-tnum"><span class="ghunk__added">+{stats.added}</span> <span class="ghunk__removed">-{stats.removed}</span></span>
                        <Show
                          when={confirming() === hunk.index}
                          fallback={<IconButton icon={Undo2} size="sm" label={t("graph.hunks.revert", { n: hunk.index + 1 })} tooltip={t("graph.hunks.revertTip")} disabled={!editable() || busy()} onClick={() => setConfirming(hunk.index)} />}
                        >
                          <Button size="sm" variant="danger" loading={busy()} onClick={() => void revert(hunk.index)}>{t("graph.hunks.discard")}</Button>
                          <Button size="sm" variant="ghost" disabled={busy()} onClick={() => setConfirming(null)}>{t("graph.hunks.keep")}</Button>
                        </Show>
                      </header>
                      <pre class="ghunk__body ui-mono"><For each={hunk.lines}>{(line) => <div class="ghunk__line" data-kind={line.kind}><span class="ghunk__sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>{line.text}</div>}</For></pre>
                    </article>
                  );
                }}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  );
}
