import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { languageKey } from "../../components/diff/logic";
import type { DiffHandle } from "../../components/diff/cm";
import { t } from "../../i18n";
import { closeTab, type TabInstance } from "../../platform/tabs";
import { repoConfig } from "../../store/workspace";
import { Button, ChevronRight, EmptyState, FileLock, FileText, IconButton, LocateFixed, Menu, RepoBadge, resolvedTheme, Save, Skeleton, TriangleAlert, WrapText, Binary, Info } from "../../ui-kit";
import { revealInProject } from "./actions";
import { attachView, buffers, currentDoc, detachView, ensureBuffer, keepMine, noteEdited, overwrite, reloadFromDisk, reopenWithEncoding, revealSecret, saveBuffer, savedDoc, setIndent, stashedState, useDiskVersion } from "./buffers";
import { createEditorState, setIndentEffect, setListenerEffect, setReadOnlyEffect, setThemeEffect, setWrapEffect } from "./cm";
import { toggleWrap, wrap } from "./prefs";
import { ENCODING_LABEL, ENCODINGS, EOL_LABEL, TABS, baseName, indentLabel, type Indent } from "./logic";
import "./editor.css";

const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const LANGUAGE_NAME: Record<string, string> = { javascript: "JavaScript", typescript: "TypeScript", jsx: "JSX", tsx: "TSX", json: "JSON", css: "CSS", html: "HTML", markdown: "Markdown", rust: "Rust", yaml: "YAML", shell: "Shell", sql: "SQL" };

const INDENTS: Indent[] = [TABS, ...[2, 4, 8].map((n) => ({ unit: " ".repeat(n), tabSize: n, label: `${n} spaces` }))];

function Breadcrumbs(props: { repoId: string; path: string }) {
  const parts = () => props.path.split("/");
  const repo = () => repoConfig(props.repoId);
  return (
    <nav class="crumbs" aria-label={t("editor.crumbs.label")}>
      <Show when={repo()}>{(r) => <RepoBadge badge={r().badge} color={r().color} size={16} title={r().name} />}</Show>
      <For each={parts().slice(0, -1)}>
        {(part, i) => (
          <>
            <button type="button" class="crumbs__seg" title={t("editor.crumbs.show", { part })} onClick={() => void revealInProject(props.repoId, parts().slice(0, i() + 1).join("/"))}>
              {part}
            </button>
            <ChevronRight size={12} class="crumbs__sep" aria-hidden="true" />
          </>
        )}
      </For>
      <span class="crumbs__file" aria-current="page">{baseName(props.path)}</span>
    </nav>
  );
}

function ConflictBanner(props: { tabId: string; onClose: () => void }) {
  const b = () => buffers[props.tabId];
  const conflict = () => b()?.conflict;
  const name = () => baseName(b()?.path ?? "");
  const [diff, setDiff] = createSignal(false);
  let host!: HTMLDivElement;
  let handle: DiffHandle | undefined;
  let token = 0;
  const unmount = () => (token++, handle?.destroy(), (handle = undefined), host?.replaceChildren());
  createEffect(
    on([diff, () => conflict()?.disk], async ([show, disk]) => {
      unmount();
      if (!show || !disk) return;
      const mine = token;
      const { mountDiff } = await import("../../components/diff/cm");
      const h = await mountDiff(host, "unified", { original: disk.text, modified: currentDoc(props.tabId) ?? "", language: languageKey(b().path), dark: resolvedTheme() === "dark" });
      if (mine !== token) return h.destroy();
      handle = h;
    }),
  );
  onCleanup(unmount);
  const message = () => {
    switch (conflict()?.kind) {
      case "external": return t("editor.conflict.external", { name: name() });
      case "stale": return t("editor.conflict.stale", { name: name() });
      default: return t("editor.conflict.deleted", { name: name() });
    }
  };
  return (
    <div class="conflict" role="alert" data-open={diff() ? "" : undefined}>
      <div class="conflict__row">
        <TriangleAlert size={14} class="conflict__icon" aria-hidden="true" />
        <span class="conflict__msg">{message()}</span>
        <span class="conflict__actions">
          <Show when={conflict()?.disk}>
            <Button size="sm" variant="ghost" onClick={() => setDiff(!diff())}>{diff() ? t("editor.conflict.hide") : t("editor.conflict.compare")}</Button>
            <Button size="sm" variant="secondary" onClick={() => useDiskVersion(props.tabId)}>{t("editor.conflict.useDisk")}</Button>
          </Show>
          <Show when={conflict()?.kind === "stale"}>
            <Button size="sm" variant="primary" onClick={() => void overwrite(props.tabId)}>{t("editor.conflict.overwrite")}</Button>
          </Show>
          <Show when={conflict()?.kind === "external"}>
            <Button size="sm" variant="primary" onClick={() => keepMine(props.tabId)}>{t("editor.conflict.keepMine")}</Button>
          </Show>
          <Show when={conflict()?.kind === "deleted"}>
            <Button size="sm" variant="secondary" onClick={props.onClose}>{t("editor.conflict.closeTab")}</Button>
            <Button size="sm" variant="primary" onClick={() => keepMine(props.tabId)}>{t("editor.conflict.keepEditing")}</Button>
          </Show>
        </span>
      </div>
      <div class="conflict__diff" ref={host} hidden={!diff()} aria-label={t("editor.conflict.diffLabel")} />
    </div>
  );
}

const posOf = (state: EditorState) => {
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  return { line: line.number, col: sel.head - line.from + 1, selected: sel.to - sel.from };
};

function EditorPane(props: { tab: TabInstance; tabId: string; repoId: string; path: string }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let gone = false;
  const b = () => buffers[props.tabId];
  const [pos, setPos] = createSignal({ line: 1, col: 1, selected: 0 });
  const dark = () => resolvedTheme() === "dark";

  const jump = () => {
    const line = props.tab.params?.line;
    if (!view || typeof line !== "number") return;
    const doc = view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    const col = typeof props.tab.params?.column === "number" ? props.tab.params.column - 1 : 0;
    view.dispatch({ selection: { anchor: Math.min(l.from + Math.max(0, col), l.to) }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    view.focus();
  };

  onMount(async () => {
    const stashed = stashedState(props.tabId);
    const state = stashed ?? (await createEditorState({ repoId: props.repoId, path: props.path, doc: savedDoc(props.tabId)!, indent: b().indent, dark: dark(), wrap: wrap(), readOnly: b().partial }));
    if (gone) return;
    view = new EditorView({ state, parent: host });
    attachView(props.tabId, view);
    view.dispatch({
      effects: [
        setListenerEffect((u) => {
          if (u.docChanged) noteEdited(props.tabId, u.state);
          if (u.docChanged || u.selectionSet) setPos(posOf(u.state));
        }),
        setThemeEffect(dark()),
        setWrapEffect(wrap()),
        setIndentEffect(b().indent),
      ],
    });
    setPos(posOf(view.state));
    if (typeof props.tab.params?.line === "number") jump();
    else view.focus();
  });
  onCleanup(() => {
    gone = true;
    if (view) detachView(props.tabId, view);
  });

  createEffect(on(dark, (d) => view?.dispatch({ effects: setThemeEffect(d) }), { defer: true }));
  createEffect(on(wrap, (w) => view?.dispatch({ effects: setWrapEffect(w) }), { defer: true }));
  createEffect(on(() => b()?.indent, (i) => i && view?.dispatch({ effects: setIndentEffect(i) }), { defer: true }));
  createEffect(on(() => b()?.partial, (p) => view?.dispatch({ effects: setReadOnlyEffect(!!p) }), { defer: true }));
  createEffect(on(() => props.tab.params?.jump, jump, { defer: true }));

  const language = () => {
    const key = languageKey(props.path);
    return key ? LANGUAGE_NAME[key] : t("editor.status.plain");
  };

  return (
    <>
      <div class="file-tab__cm" ref={host} />
      <footer class="file-tab__status">
        <span class="file-tab__pos ui-tnum">
          {t("editor.status.pos", { line: pos().line, col: pos().col })}
          <Show when={pos().selected > 0}>{" "}{t("editor.status.selected", { n: pos().selected })}</Show>
        </span>
        <span class="file-tab__spacer" />
        <Menu
          aria-label={t("editor.status.indentLabel")}
          items={INDENTS.map((i) => ({ label: indentLabel(i), checked: b().indent.unit === i.unit, onSelect: () => setIndent(props.tabId, i) }))}
          trigger={(p) => (
            <button type="button" class="chip" {...p} title={t("editor.status.indentTitle")}>
              {indentLabel(b().indent)}
            </button>
          )}
        />
        <Menu
          aria-label={t("editor.status.encodingLabel")}
          items={ENCODINGS.map((e) => ({ label: ENCODING_LABEL[e], checked: b().encoding === e, onSelect: () => void reopenWithEncoding(props.tabId, e) }))}
          trigger={(p) => (
            <button type="button" class="chip" {...p} title={t("editor.status.encodingTitle")}>
              {ENCODING_LABEL[b().encoding]}
            </button>
          )}
        />
        <span class="chip chip--static" title={b().eol === "mixed" ? t("editor.status.eolMixed") : t("editor.status.eol")}>{b().eol === "mixed" ? t("editor.status.eolMixedChip") : EOL_LABEL[b().eol]}</span>
        <span class="chip chip--static">{language()}</span>
        <span class="chip chip--static ui-tnum">{formatBytes(b().size)}</span>
      </footer>
    </>
  );
}

/** The `file` tab type: an editable CodeMirror buffer for a repo-relative path. State lives in `buffers`, so a remount keeps edits and undo history. */
export default function FileTab(props: { tab: TabInstance }) {
  const tabId = props.tab.id;
  const repoId = String(props.tab.params?.repoId);
  const path = String(props.tab.params?.path);
  ensureBuffer(tabId, repoId, path);
  const b = () => buffers[tabId];
  const status = createMemo(() => b()?.status ?? "loading");

  return (
    <div class="file-tab">
      <header class="file-tab__bar">
        <Breadcrumbs repoId={repoId} path={path} />
        <span class="file-tab__spacer" />
        <Show when={b()?.dirty}>
          <Button size="sm" variant="secondary" icon={Save} loading={b()?.saving} onClick={() => void saveBuffer(tabId)}>{t("editor.bar.save")}</Button>
        </Show>
        <IconButton icon={WrapText} label={t("editor.bar.wrap")} size="sm" pressed={wrap()} onClick={toggleWrap} />
        <IconButton icon={LocateFixed} label={t("editor.bar.reveal")} size="sm" onClick={() => void revealInProject(repoId, path)} />
      </header>
      <Show when={b()?.conflict}>
        <ConflictBanner tabId={tabId} onClose={() => closeTab(tabId, { force: true })} />
      </Show>
      <Show when={b()?.partial}>
        <div class="file-tab__notice" role="status">
          <Info size={14} class="file-tab__notice-icon" aria-hidden="true" />
          <span>{t("editor.notice.partial", { name: baseName(path), size: formatBytes(b().size) })}</span>
        </div>
      </Show>
      <div class="file-tab__body">
        <Switch>
          <Match when={status() === "loading"}>
            <div class="file-tab__loading" aria-busy="true" aria-label={t("editor.state.loading")}>
              <For each={[34, 58, 46, 66, 40, 52]}>{(w) => <Skeleton height={14} width={`${w}%`} />}</For>
            </div>
          </Match>
          <Match when={status() === "ready"}>
            <EditorPane tab={props.tab} tabId={tabId} repoId={repoId} path={path} />
          </Match>
          <Match when={status() === "secret"}>
            <EmptyState
              icon={FileLock}
              title={t("editor.state.secretTitle")}
              description={t("editor.state.secretDesc")}
              action={<Button size="sm" variant="secondary" onClick={() => void revealSecret(tabId)}>{t("editor.state.reveal")}</Button>}
            />
          </Match>
          <Match when={status() === "binary"}>
            <EmptyState icon={Binary} title={t("editor.state.binaryTitle")} description={t("editor.state.binaryDesc", { name: baseName(path), size: formatBytes(b().size) })} />
          </Match>
          <Match when={status() === "tooLarge"}>
            <EmptyState icon={FileText} title={t("editor.state.largeTitle")} description={t("editor.state.largeDesc", { name: baseName(path), size: formatBytes(b().size) })} />
          </Match>
          <Match when={status() === "error"}>
            <EmptyState
              tone="danger"
              icon={TriangleAlert}
              title={t("editor.state.errorTitle")}
              description={b().error}
              action={<Button size="sm" variant="secondary" onClick={() => void reloadFromDisk(tabId)}>{t("editor.state.retry")}</Button>}
            />
          </Match>
        </Switch>
      </div>
    </div>
  );
}
