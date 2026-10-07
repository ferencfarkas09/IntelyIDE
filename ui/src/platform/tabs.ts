import type { LucideIcon } from "lucide-solid";
import { createMemo, createRoot, createSignal, type Component } from "solid-js";
import { createRegistry } from "./registry";

export interface TabInstance {
  id: string;
  type: string;
  title: string;
  /** Whatever the tab type needs to render, e.g. `{ repoId, path }` for an editor. */
  params?: Record<string, unknown>;
  dirty?: boolean;
}

export interface TabType {
  /** Unique type name, e.g. "editor", "diff". Also the registry id. */
  type: string;
  title: string;
  icon: LucideIcon;
  /** Lazy component; receives the instance. */
  component: Component<{ tab: TabInstance }>;
  /** `false` pins the tab; a function decides per instance (e.g. refuse while a save is running). */
  canClose: boolean | ((tab: TabInstance) => boolean);
  /** Runs before a close. Returning false vetoes it (a dirty editor asks first and calls `closeTab(id, { force: true })` itself). */
  beforeClose?: (tab: TabInstance) => boolean;
}

const types = createRegistry<TabType & { id: string }>(() => 0, "tab-type");

export const registerTabType = (t: TabType) => types.register({ ...t, id: t.type });
export const getTabType = (type: string): TabType | undefined => types.get(type);
export const tabTypes = types.items;

const [tabs, setTabs] = createSignal<readonly TabInstance[]>([]);
const [activeId, setActiveId] = createSignal<string | null>(null);

export { tabs };
// Module-level state lives for the whole session, so the memo gets its own root.
export const activeTab = createRoot(() => createMemo((): TabInstance | undefined => tabs().find((t) => t.id === activeId())));

/** Opens (or focuses, when `id` already exists) a tab and returns its id. Without `id` a fresh one is generated. */
export function openTab(input: { type: string; id?: string; title?: string; params?: Record<string, unknown>; dirty?: boolean }): string {
  const type = types.get(input.type);
  if (!type) throw new Error(`Unknown tab type "${input.type}"`);
  const id = input.id ?? `${input.type}:${crypto.randomUUID()}`;
  const existing = tabs().find((t) => t.id === id);
  if (existing) {
    if (input.title !== undefined || input.params || input.dirty !== undefined) {
      setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...(input.title !== undefined && { title: input.title }), ...(input.params && { params: input.params }), ...(input.dirty !== undefined && { dirty: input.dirty }) } : t)));
    }
  } else {
    setTabs((all) => [...all, { id, type: input.type, title: input.title ?? type.title, params: input.params, dirty: input.dirty }]);
  }
  setActiveId(id);
  return id;
}

export function canCloseTab(tab: TabInstance): boolean {
  const c = types.get(tab.type)?.canClose;
  return typeof c === "function" ? c(tab) : (c ?? true);
}

/** Closes a tab unless its type refuses; the neighbour to the left (else right) becomes active. Returns whether it closed. */
export function closeTab(id: string, opts?: { force?: boolean }): boolean {
  const all = tabs();
  const at = all.findIndex((t) => t.id === id);
  if (at < 0 || !canCloseTab(all[at])) return false;
  if (!opts?.force && types.get(all[at].type)?.beforeClose?.(all[at]) === false) return false;
  const rest = all.filter((t) => t.id !== id);
  setTabs(rest);
  if (activeId() === id) setActiveId((rest[at - 1] ?? rest[at])?.id ?? null);
  return true;
}

export const activateTab = (id: string): void => void (tabs().some((t) => t.id === id) && setActiveId(id));

export function updateTab(id: string, patch: Partial<Pick<TabInstance, "title" | "dirty" | "params">>): void {
  setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

/** Ctrl+Tab order: +1 next, -1 previous, wrapping. */
export function cycleTab(step: 1 | -1): void {
  const all = tabs();
  if (all.length < 2) return;
  const at = all.findIndex((t) => t.id === activeId());
  setActiveId(all[(at + step + all.length) % all.length].id);
}

export const resetTabs = () => (types.clear(), setTabs([]), setActiveId(null));

export interface TabSnapshot {
  id: string;
  type: string;
  title: string;
  params?: Record<string, unknown>;
}

/** The open tabs as plain data (JSON-safe params only) and the active one, for the per-workspace UI state. */
export function snapshotTabs(): { tabs: TabSnapshot[]; activeTabId: string | null } {
  const list: TabSnapshot[] = [];
  for (const tab of tabs()) {
    let params: Record<string, unknown> | undefined;
    try {
      params = tab.params ? (JSON.parse(JSON.stringify(tab.params)) as Record<string, unknown>) : undefined;
    } catch {
      continue;
    }
    list.push({ id: tab.id, type: tab.type, title: tab.title, ...(params && { params }) });
  }
  return { tabs: list, activeTabId: activeId() };
}

/**
 * Reopens snapshotted tabs without touching the tab-type registry (unlike `resetTabs`). Only types in `allow` that are
 * registered right now are opened; the rest is counted as skipped. `failed` counts tabs that threw while opening.
 */
export function restoreTabs(list: readonly TabSnapshot[], activeTabId: string | null, allow: ReadonlySet<string>): { restored: number; skipped: number; failed: number } {
  let restored = 0;
  let skipped = 0;
  let failed = 0;
  for (const tab of list) {
    if (!allow.has(tab.type) || !types.get(tab.type) || tabs().some((x) => x.id === tab.id)) {
      skipped++;
      continue;
    }
    try {
      openTab({ type: tab.type, id: tab.id, title: tab.title, params: tab.params });
      restored++;
    } catch {
      failed++;
    }
  }
  if (activeTabId && tabs().some((x) => x.id === activeTabId)) setActiveId(activeTabId);
  return { restored, skipped, failed };
}

