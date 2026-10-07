import "./editor.css";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { repos } from "../../store/workspace";
import { Dialog, EmptyState, FileSearch, Icon, Input, RepoBadge, Search, File, Spinner } from "../../ui-kit";
import { openFile, recentFiles } from "./buffers";
import { showDialog } from "./dialogs";
import { baseName, parentDir, rankFiles } from "./logic";

export interface Candidate {
  repoId: string;
  path: string;
}

const MAX_RESULTS = 60;

const indexes = new Map<string, Promise<string[]>>();
let watching = false;
function index(repoId: string): Promise<string[]> {
  if (!watching) {
    watching = true;
    // A created or deleted file changes the index; edits do not.
    ipc.files.onFileChanged((e) => e.kind !== "changed" && indexes.delete(e.repoId));
  }
  let cached = indexes.get(repoId);
  if (!cached) {
    cached = ipc.files.quickOpenIndex(repoId);
    indexes.set(repoId, cached);
    cached.catch(() => indexes.delete(repoId));
  }
  return cached;
}

export const resetQuickOpen = (): void => indexes.clear();

/** "name:42" opens at line 42. */
export function parseQuery(raw: string): { text: string; line?: number } {
  const m = /^(.*?):(\d+)$/.exec(raw.trim());
  return m ? { text: m[1], line: Number(m[2]) } : { text: raw.trim() };
}

function QuickOpen(props: { open: () => boolean; close: () => void }) {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [all] = createResource(async (): Promise<Candidate[]> => {
    const lists = await Promise.all(repos().map(async (r) => (await index(r.id).catch(() => [])).map((path) => ({ repoId: r.id, path }))));
    return lists.flat();
  });
  const known = createMemo(() => new Set((all() ?? []).map((c) => `${c.repoId}:${c.path}`)));
  const parsed = () => parseQuery(query());
  const results = createMemo((): { items: Candidate[]; recent: number } => {
    const list = all() ?? [];
    if (!parsed().text) {
      const recent = recentFiles().filter((r) => known().has(`${r.repoId}:${r.path}`));
      return { items: [...recent, ...list.filter((c) => !recent.some((r) => r.repoId === c.repoId && r.path === c.path))].slice(0, MAX_RESULTS), recent: recent.length };
    }
    return { items: rankFiles(list, (c) => c.path, parsed().text, MAX_RESULTS), recent: 0 };
  });
  const repo = (id: string) => repos().find((r) => r.id === id);
  const choose = (c: Candidate | undefined) => {
    if (!c) return;
    props.close();
    openFile(c.repoId, c.path, { line: parsed().line });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = results().items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (n ? (c + (e.key === "ArrowDown" ? 1 : -1) + n) % n : 0));
      queueMicrotask(() => document.getElementById(`qo-${cursor()}`)?.scrollIntoView({ block: "nearest" }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results().items[cursor()]);
    }
  };

  return (
    <Dialog open={props.open()} onClose={props.close} title={t("editor.qo.title")} size="md" class="qo">
      <div class="qo__body">
        <Input
          data-autofocus
          size="lg"
          placeholder={t("editor.qo.placeholder")}
          aria-label={t("editor.qo.fileName")}
          role="combobox"
          aria-expanded="true"
          aria-controls="qo-list"
          aria-activedescendant={results().items.length ? `qo-${cursor()}` : undefined}
          leading={<Icon icon={Search} size={14} />}
          value={query()}
          onInput={(e) => (setQuery(e.currentTarget.value), setCursor(0))}
          onKeyDown={onKeyDown}
        />
        <div class="qo__list" id="qo-list" role="listbox" aria-label={t("editor.qo.files")}>
          <Show when={!all.loading} fallback={<div class="qo__state"><Spinner /></div>}>
            <For each={results().items} fallback={<EmptyState size="sm" icon={FileSearch} title={t("editor.qo.none")} description={t("editor.qo.noneDesc")} />}>
              {(c, i) => (
                <>
                  <Show when={i() === 0 && results().recent > 0}><div class="qo__heading">{t("editor.qo.recent")}</div></Show>
                  <Show when={i() === results().recent && results().recent > 0 && !parsed().text}><div class="qo__heading">{t("editor.qo.files")}</div></Show>
                  <div
                    id={`qo-${i()}`}
                    class="qo__item"
                    role="option"
                    aria-selected={i() === cursor()}
                    onPointerMove={() => cursor() !== i() && setCursor(i())}
                    onClick={() => choose(c)}
                  >
                    <Icon icon={File} size={14} />
                    <span class="qo__name">{baseName(c.path)}</span>
                    <span class="qo__dir ui-truncate">{parentDir(c.path)}</span>
                    <Show when={repos().length > 1 && repo(c.repoId)}>{(r) => <RepoBadge badge={r().badge} color={r().color} size={16} title={r().name} />}</Show>
                  </div>
                </>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}

let openNow = false;

/** Cmd+P: fuzzy file finder over the index of every repo. */
export function openQuickOpen(): void {
  if (openNow) return;
  openNow = true;
  void showDialog<void>((answer, open) => <QuickOpen open={open} close={() => answer()} />).then(() => (openNow = false));
}
