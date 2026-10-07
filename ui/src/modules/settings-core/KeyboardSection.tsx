import { createMemo, For, Show } from "solid-js";
import { t } from "../../i18n";
import { allCommands } from "../../platform/commands";
import { formatChord, shortcutConflicts, shortcuts, type Shortcut } from "../../platform/keymap";
import { Badge, Kbd, TriangleAlert } from "../../ui-kit";
import { groupShortcuts, type ShortcutRow } from "./keyboard";
import "./settings-core.css";

function Chord(props: { keys: string }) {
  return (
    <span class="sc-chord">
      <For each={formatChord(props.keys)}>{(k) => <Kbd>{k}</Kbd>}</For>
    </span>
  );
}

function Row(props: { row: ShortcutRow }) {
  return (
    <li class="sc-shortcut" data-conflict={props.row.conflict ? "" : undefined}>
      <span class="sc-shortcut__title ui-truncate">{props.row.title}</span>
      <Show when={props.row.conflict}>
        <Badge tone="danger" icon={TriangleAlert} title={t("keyboard.conflictTip")}>{t("keyboard.conflict")}</Badge>
      </Show>
      <Chord keys={props.row.keys} />
    </li>
  );
}

export default function KeyboardSection() {
  const groups = createMemo(() => groupShortcuts(shortcuts() as readonly Shortcut[], allCommands()));
  return (
    <div class="sc-section">
      <p class="sc-muted">{t("keyboard.intro")}</p>
      <Show when={shortcutConflicts().length}>
        <p class="sc-warning" role="alert"><TriangleAlert size={14} /> {t("keyboard.conflicts", { count: shortcutConflicts().length })}</p>
      </Show>
      <For each={groups()}>
        {(group) => (
          <section class="sc-shortcuts">
            <h4 class="sc-shortcuts__group">{group.group}</h4>
            <ul class="sc-shortcuts__list" aria-label={t("keyboard.list", { group: group.group })}>
              <For each={group.rows}>{(row) => <Row row={row} />}</For>
            </ul>
          </section>
        )}
      </For>
    </div>
  );
}
