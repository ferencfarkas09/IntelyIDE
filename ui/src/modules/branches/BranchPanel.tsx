import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import type { RepoConfig, RepoSnapshot } from "../../ipc";
import { ipc } from "../../ipc";
import { workspace } from "../../store/workspace";
import { AheadBehind, Badge, Button, Copy, EmptyState, GitBranch, GitFork, IconButton, Icon, Input, Lock, Plus, RepoBadge, Search, Spinner, toast, Trash2, Undo2 } from "../../ui-kit";
import { checkoutBranch } from "./actions";
import { filterBranches, isLive, livePatterns, stripRemote } from "./logic";
import { branchesRev, openDialog } from "./uiState";
import "./branches.css";

interface Entry {
  name: string;
  remote: boolean;
}

/** Body of the branch popup that hangs off a repo pill in the title bar. */
export default function BranchPanel(props: { repo: RepoConfig; snapshot?: RepoSnapshot; close: () => void }) {
  const [list, { refetch }] = createResource(() => [props.repo.id, branchesRev()] as const, ([id]) => ipc.branches.list(id));
  const [filter, setFilter] = createSignal("");
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const live = createMemo(() => livePatterns(workspace(), props.repo.id));
  const current = () => list()?.current ?? props.snapshot?.head.branch ?? null;

  const entries = createMemo<Entry[]>(() => {
    const l = list();
    if (!l) return [];
    const local = filterBranches(l.local.filter((b) => b !== l.current), filter()).map((name) => ({ name, remote: false }));
    const localNames = new Set(l.local);
    const remote = filterBranches(l.remote.filter((r) => !r.endsWith("/HEAD") && !localNames.has(stripRemote(r))), filter(), true).map((name) => ({ name, remote: true }));
    return [...local, ...remote];
  });
  createEffect(on(filter, () => setActive(0)));

  const checkout = (entry: Entry) => {
    props.close();
    void checkoutBranch(props.repo.id, entry.name);
  };
  const newBranch = (from?: string) => {
    props.close();
    openDialog({ kind: "newBranch", repoId: props.repo.id, from });
  };
  const switchAll = (entry: Entry) => {
    props.close();
    openDialog({ kind: "switchAll", name: entry.remote ? stripRemote(entry.name) : entry.name });
  };
  const copy = (name: string) =>
    void navigator.clipboard?.writeText(name).then(
      () => toast.success(t("branches.copied"), name),
      () => toast.error(t("branches.copyFailed")),
    );
  const remove = (entry: Entry) => {
    props.close();
    openDialog({ kind: "delete", repoId: props.repo.id, name: entry.name, live: isLive(entry.name, live()), needsForce: false });
  };

  const onKey = (e: KeyboardEvent) => {
    const all = entries();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.min(all.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && all[active()]) {
      e.preventDefault();
      checkout(all[active()]);
    } else if (e.key === "ArrowRight" && all[active()] && input.selectionStart === filter().length) {
      e.preventDefault();
      actionButtons(all[active()])[0]?.focus();
    }
  };
  const actionButtons = (entry: Entry) => [...(document.getElementById(optionId(entry))?.querySelectorAll<HTMLButtonElement>(".bpl__acts button") ?? [])];
  /** Arrow keys walk the buttons of the active row; leaving at either end returns to the filter. */
  const onActionKey = (e: KeyboardEvent, entry: Entry) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = actionButtons(entry);
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    const to = e.key === "ArrowRight" ? buttons[at + 1] : e.key === "ArrowLeft" ? buttons[at - 1] : undefined;
    (to ?? input).focus();
  };

  createEffect(() => {
    const entry = entries()[active()];
    if (entry) document.getElementById(optionId(entry))?.scrollIntoView?.({ block: "nearest" });
  });
  const optionId = (entry: Entry) => `bp-${props.repo.id}-${entry.remote ? "r" : "l"}-${entry.name}`;

  const row = (entry: Entry, index: () => number) => (
    <div id={optionId(entry)} class="bpl__row" role="option" aria-selected={active() === index()} data-active={active() === index() ? "" : undefined} onMouseMove={() => setActive(index())} onClick={() => checkout(entry)}>
      <Icon icon={GitBranch} size={14} class="bpl__icon" />
      <span class="bpl__name ui-truncate" title={entry.name}>
        {entry.name}
      </span>
      <Show when={isLive(entry.name, live(), entry.remote)}>
        <Badge size="sm" tone="warn" icon={Lock} title={t("branches.liveTipPush")}>
          {t("branches.live")}
        </Badge>
      </Show>
      <span class="bpl__acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => onActionKey(e, entry)}>
        <IconButton icon={Plus} label={t("branches.newFrom", { name: entry.name })} tooltip={t("branches.newFromTip")} size="sm" tabIndex={-1} onClick={() => newBranch(entry.name)} />
        <IconButton icon={GitFork} label={t("branches.switchAllTo", { name: entry.name })} tooltip={t("branches.switchAllToTip")} size="sm" tabIndex={-1} onClick={() => switchAll(entry)} />
        <IconButton icon={Copy} label={t("branches.copyName", { name: entry.name })} tooltip={t("branches.copyNameTip")} size="sm" tabIndex={-1} onClick={() => copy(entry.name)} />
        <Show when={!entry.remote}>
          <IconButton icon={Trash2} label={t("branches.deleteName", { name: entry.name })} tooltip={t("branches.deleteTip")} size="sm" tabIndex={-1} onClick={() => remove(entry)} />
        </Show>
      </span>
    </div>
  );

  return (
    <div class="bpl">
      <div class="bpl__head">
        <RepoBadge color={props.repo.color} badge={props.repo.badge} size={20} />
        <span class="bpl__repo ui-truncate" title={props.repo.path}>
          {props.repo.name}
        </span>
      </div>
      <Input ref={input} size="sm" aria-label={t("branches.find")} placeholder={t("branches.find")} autocomplete="off" spellcheck={false} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} onKeyDown={onKey} leading={<Icon icon={Search} size={14} />} />

      <Show when={current()}>
        {(name) => (
          <div class="bpl__current">
            <span class="bpl__label">{t("branches.current")}</span>
            <span class="bpl__cur-name ui-truncate" title={name()}>
              <Icon icon={GitBranch} size={14} />
              {name()}
            </span>
            <Show when={isLive(name(), live())}>
              <Badge size="sm" tone="warn" icon={Lock} title={t("branches.liveTip")}>
                {t("branches.live")}
              </Badge>
            </Show>
            <AheadBehind ahead={list()?.ahead ?? props.snapshot?.ahead ?? 0} behind={list()?.behind ?? props.snapshot?.behind ?? 0} />
          </div>
        )}
      </Show>
      <Show when={list()?.upstream}>
        {(up) => (
          <div class="bpl__up ui-mono ui-truncate" title={up()}>
            {t("branches.tracking", { name: up() })}
          </div>
        )}
      </Show>

      <div class="bpl__list" role="listbox" aria-label={t("branches.list")}>
        <Show when={!list.loading || list()} fallback={<div class="bpl__loading"><Spinner size={16} label={t("branches.loading")} /></div>}>
          <Show when={!list.error} fallback={<EmptyState size="sm" tone="danger" icon={GitBranch} title={t("branches.loadFailed")} description={String((list.error as { message?: string })?.message ?? list.error)} action={<Button size="sm" icon={Undo2} onClick={() => void refetch()}>{t("branches.retry")}</Button>} />}>
            <Show when={entries().length > 0} fallback={<div class="bpl__none">{filter() ? t("branches.noMatch", { filter: filter() }) : t("branches.noOthers")}</div>}>
              <Show when={entries().some((e) => !e.remote)}>
                <div class="bpl__group">{t("branches.local")}</div>
                <For each={entries().filter((e) => !e.remote)}>{(entry) => row(entry, () => entries().indexOf(entry))}</For>
              </Show>
              <Show when={entries().some((e) => e.remote)}>
                <div class="bpl__group">{t("branches.remote")}</div>
                <For each={entries().filter((e) => e.remote)}>{(entry) => row(entry, () => entries().indexOf(entry))}</For>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
      <div class="bpl__foot">
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => newBranch()}>
          {t("branches.newBranchBtn")}
        </Button>
        <Button size="sm" variant="ghost" icon={GitFork} onClick={() => (props.close(), openDialog({ kind: "switchAll" }))}>
          {t("branches.switchAllBtnDots")}
        </Button>
      </div>
    </div>
  );
}
