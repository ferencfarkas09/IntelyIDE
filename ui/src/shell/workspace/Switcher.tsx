import { createMemo, Show } from "solid-js";
import { t } from "../../i18n";
import { formatChord, shortcutFor } from "../../platform/keymap";
import { workspaceState } from "../../store/workspace";
import { activeSummary, isPinned, requestSwitch, switcherRecents } from "../../store/workspaces";
import { ChevronDown, FolderGit2, Icon, Menu, MiddleEllipsis, Spinner, Tooltip, type MenuEntry } from "../../ui-kit";
import { execute } from "../../platform/commands";
import { setSwitcherOpen, switcherOpen } from "./dialogs";

const chord = (command: string): string[] | undefined => {
  const keys = shortcutFor(command);
  return keys ? formatChord(keys) : undefined;
};
const run = (id: string) => () => void execute(id);

/**
 * The workspace menu in the title bar (3.7): colour dot, name, chevron. Recent workspaces are exclusive choices; the open
 * one is checked and disabled. Pinned mode (INTELY_WORKSPACE) shows its one entry read-only.
 */
export function Switcher() {
  const switching = () => workspaceState() === "switching";
  const empty = () => workspaceState() === "empty";
  const name = createMemo(() => (isPinned() ? t("ws.pinnedName") : (activeSummary()?.name ?? t("switch.none"))));
  const color = () => activeSummary()?.color;

  const items = (): MenuEntry[] => {
    if (isPinned()) return [{ label: t("switch.pinnedItem", { name: t("ws.pinnedName") }), checked: true, radio: true, disabled: true, onSelect: () => undefined }];
    const recent: MenuEntry[] = switcherRecents().map((w) => ({
      label: w.name,
      description: t("switch.repos", { count: w.repos.length }),
      checked: w.id === activeSummary()?.id,
      radio: true,
      disabled: w.id === activeSummary()?.id,
      onSelect: () => void requestSwitch(w.id),
    }));
    const open = activeSummary() !== undefined;
    return [
      ...(recent.length ? [{ type: "label", label: t("switch.recent") } as MenuEntry, ...recent, { type: "separator" } as MenuEntry] : []),
      { label: t("switch.open"), shortcut: chord("workspace.open"), onSelect: run("workspace.open") },
      { label: t("switch.new"), shortcut: chord("workspace.new"), onSelect: run("workspace.new") },
      { label: t("switch.scan"), onSelect: run("workspace.scan") },
      ...(open ? [{ label: t("switch.add"), shortcut: chord("workspace.addRepo"), onSelect: run("workspace.addRepo") } as MenuEntry] : []),
      { type: "separator" },
      { label: t("switch.manage"), onSelect: run("workspace.manage") },
      ...(open ? [{ label: t("switch.close"), onSelect: run("workspace.close") } as MenuEntry] : []),
    ];
  };

  return (
    <Menu
      aria-label={t("switch.label")}
      placement="bottom-start"
      open={switcherOpen()}
      onOpenChange={setSwitcherOpen}
      items={items()}
      trigger={(tp) => (
        <Tooltip label={isPinned() ? t("ws.pinnedTip") : t("switch.label")} placement="bottom">
          <button
            {...tp}
            type="button"
            class="switcher"
            data-empty={empty() ? "" : undefined}
            disabled={switching()}
            aria-label={empty() ? t("switch.none") : t("switch.labelNamed", { name: name() })}
          >
            <Show when={switching()} fallback={<Show when={color()} fallback={<Icon icon={FolderGit2} size={14} />}>{(c) => <span class="switcher__dot" style={{ "--wc": c() }} aria-hidden="true" />}</Show>}>
              <Spinner size={14} />
            </Show>
            <span class="switcher__name" dir="auto">
              <MiddleEllipsis text={name()} />
            </span>
            <Icon icon={ChevronDown} size={12} />
          </button>
        </Tooltip>
      )}
    />
  );
}
