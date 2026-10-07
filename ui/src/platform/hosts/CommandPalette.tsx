import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import { Dialog, Icon, Input, Kbd, Search } from "../../ui-kit";
import { availableCommands, execute, groupLabel, recentCommands, searchCommands, type Command } from "../commands";
import { formatChord } from "../keymap";
import "./platform.css";

const [open, setOpen] = createSignal(false);

export const paletteOpen = open;
export const openPalette = () => setOpen(true);
export const closePalette = () => setOpen(false);
export const togglePalette = () => void setOpen(!open());

/** Rows of the list: group headings are derived, not selectable. Without a query the recent commands form their own group. */
export interface PaletteRow {
  heading?: string;
  command?: Command;
  /** Show the group chip: where the list is not already under the command's own group heading. */
  showGroup?: boolean;
}

export function paletteRows(query: string, list: readonly Command[], recents: readonly string[]): PaletteRow[] {
  const ranked = searchCommands(query, list, recents);
  const rows: PaletteRow[] = [];
  if (query.trim()) {
    ranked.forEach((command) => rows.push({ command, showGroup: true }));
    return rows;
  }
  const recent = recents.map((id) => ranked.find((c) => c.id === id)).filter((c): c is Command => !!c);
  if (recent.length) rows.push({ heading: t("palette.recent") }, ...recent.map((command) => ({ command, showGroup: true })));
  let group = "";
  for (const command of ranked.filter((c) => !recent.includes(c))) {
    if (groupLabel(command.group) !== group) {
      group = groupLabel(command.group);
      rows.push({ heading: group });
    }
    rows.push({ command });
  }
  return rows;
}

export function CommandPalette() {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const rows = createMemo(() => (open() ? paletteRows(query(), availableCommands(), recentCommands()) : []));
  const selectable = createMemo(() => rows().flatMap((r) => (r.command ? [r.command] : [])));
  createEffect(on(open, (o) => o && (setQuery(""), setIndex(0))));
  createEffect(on(query, () => setIndex(0)));
  let list: HTMLDivElement | undefined;

  const run = (command: Command | undefined) => {
    if (!command) return;
    closePalette();
    // After the dialog has returned focus, so a command that opens another dialog keeps its own focus.
    setTimeout(() => void execute(command.id).catch((err) => console.error(`Command ${command.id} failed`, err)), 0);
  };
  const move = (step: number) => {
    const n = selectable().length;
    if (!n) return;
    setIndex((i) => (i + step + n) % n);
    queueMicrotask(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Enter" && !e.isComposing) (e.preventDefault(), run(selectable()[index()]));
  };

  return (
    <Dialog open={open()} onClose={closePalette} title={t("palette.title")} hideClose class="palette" size="lg">
      <div class="palette__body" onKeyDown={onKeyDown}>
        <Input
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-label={t("palette.search")}
          placeholder={t("palette.placeholder")}
          autocomplete="off"
          spellcheck={false}
          leading={<Icon icon={Search} size={14} />}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div ref={list} id="palette-list" class="palette__list" role="listbox" aria-label={t("palette.list")}>
          <Show when={selectable().length} fallback={<div class="palette__empty">{t("palette.none")}</div>}>
            <For each={rows()}>
              {(row) => {
                const at = () => (row.command ? selectable().indexOf(row.command) : -1);
                return row.heading ? (
                  <div class="palette__heading" role="presentation">
                    {row.heading}
                  </div>
                ) : (
                  <div class="palette__item" role="option" aria-selected={at() === index()} onPointerMove={() => setIndex(at())} onClick={() => run(row.command)}>
                    <span class="palette__title ui-truncate">{row.command!.title}</span>
                    <Show when={row.showGroup}>
                      <span class="palette__group">{groupLabel(row.command!.group)}</span>
                    </Show>
                    <Show when={row.command!.shortcut}>{(keys) => <Kbd keys={formatChord(keys())} />}</Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
