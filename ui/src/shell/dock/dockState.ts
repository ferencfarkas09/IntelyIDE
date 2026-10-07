import { createEffect, createRoot, createSignal, on } from "solid-js";
import { readScoped, writeScoped } from "../../store/scopedStorage";
import { activeId } from "../../store/workspaces";
import { dockFits, panelOpen, setPanelOpen } from "../layout";
import { dockTabs } from "./registry";

/** `?dock=<tab id>` opens the dock on a tab for screenshots and manual checks. */
const fromUrl = new URLSearchParams(globalThis.location?.search).get("dock");
const storedOpen = readScoped("intely.layout.dock");
const [open, setOpen] = createSignal(fromUrl ? true : storedOpen === "1");
const [active, setActive] = createSignal<string>(fromUrl ?? readScoped("intely.layout.dock.tab") ?? "agents");

// The dock shows the agent threads of the workspace it was last used in: each workspace remembers its own state.
createRoot(() =>
  createEffect(
    on(
      activeId,
      (id) => {
        if (!id || fromUrl) return;
        setOpen(readScoped("intely.layout.dock", id) === "1");
        setActive(readScoped("intely.layout.dock.tab", id) ?? "agents");
      },
      { defer: true },
    ),
  ),
);

export const dockOpen = open;
/** The dock is on screen: wanted, and there is room next to the centre (narrow windows collapse it first). */
export const dockVisible = (): boolean => open() && dockFits();
/** The tab to show: the remembered one when it still exists, else the first registered. */
export const activeDockTab = () => dockTabs().find((t) => t.id === active()) ?? dockTabs()[0];

export function setDockOpen(next: boolean): void {
  setOpen(next);
  writeScoped("intely.layout.dock", next ? "1" : "0");
}

export function openDockTab(id: string): void {
  setActive(id);
  writeScoped("intely.layout.dock.tab", id);
  setDockOpen(true);
  // Asked for explicitly in a narrow window: the Commit panel makes room instead of the dock staying invisible.
  if (!dockFits() && panelOpen()) setPanelOpen(false);
}

/** Rail button behaviour: clicking the open tab again hides the dock; a dock that is open but collapsed by the width is brought back. */
export function toggleDockTab(id: string): void {
  if (open() && activeDockTab()?.id === id && dockVisible()) setDockOpen(false);
  else openDockTab(id);
}
