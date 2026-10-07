// The right dock registry predates the platform folder (track 2a); modules import it from here.
export { dockTabs, registerDockTab, type DockTab } from "../shell/dock/registry";
export { activeDockTab, dockOpen, dockVisible, openDockTab, setDockOpen, toggleDockTab } from "../shell/dock/dockState";
