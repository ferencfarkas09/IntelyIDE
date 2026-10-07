import { lazy, createSignal, Suspense, type Component } from "solid-js";
import { fmt, t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ConnectionView, StudioStatus } from "../../ipc/mongo";
import { registerUnsavedSource } from "../../platform/closeGuard";
import { registerCommand } from "../../platform/commands";
import { registerRailItem } from "../../platform/rail";
import { activeTab, closeTab, openTab, registerTabType, tabs, updateTab } from "../../platform/tabs";
import { registerStatusItem } from "../../platform/statusbar";
import type { Disposer } from "../../platform/registry";
import { Database, Skeleton, Table2 } from "../../ui-kit";
import { activeController, hasController } from "./controller";
import { vanished } from "./onboarding/lost";

// The switch lives here and nothing else is loaded while it is off: no rail item, no tab types, no commands, no chunk.
// Turning it on registers the studio pieces (all lazy); turning it off removes them and closes the studio tabs.

const [on, setOn] = createSignal(false);
const [built, setBuilt] = createSignal<boolean | undefined>(undefined);
const [snapshot, setSnapshot] = createSignal<StudioStatus>();
/** The latest status of the gateway: the open connections, the notices (a safety reset) and the network rule of the jail. */
export const studioSnapshot = snapshot;
/** A connect that just succeeded, before the state event arrives. */
export const noteConnected = (v: ConnectionView) => {
  setSnapshot((s) => (s && !s.connections.some((c) => c.id === v.id) ? { ...s, connections: [...s.connections, v] } : s));
  clearLost(v.id);
};

// A connection that disappears from the gateway's list without the user closing it (the SSH master died, the network dropped,
// the Mac slept) is "lost": the card and the tabs show a Disconnected banner with Reconnect. Nothing reconnects by itself (5.12).
export interface LostConnection {
  name: string;
  tunnel: boolean;
}
const [lost, setLost] = createSignal<Record<string, LostConnection>>({});
export const lostConnections = lost;
export const clearLost = (id?: string) => setLost((all) => (id === undefined ? {} : Object.fromEntries(Object.entries(all).filter(([k]) => k !== id))));
const expected = new Set<string>();
/** Call right before the user disconnects, deletes or replaces a connection on purpose, so it is not reported as lost. */
export const expectClose = (id: string) => void expected.add(id);
/** True while the Settings switch is on and the build has the feature. */
export const studioEnabled = on;
/** Whether this build contains MongoDB Studio at all (undefined until the first status answer). */
export const studioCompiled = built;

export const CONNECTIONS_TAB = "mongo:connections";
/** What the Connections tab should do on open (palette commands): the nonce makes the same action repeatable. */
export type ConnectionsAction = "new" | "wizard" | "import" | "export";
export const collectionTabId = (connectionId: string, db: string, collection: string) => `mongo:${connectionId}:${db}.${collection}`;

export interface CollectionTabParams {
  connectionId: string;
  connectionName: string;
  db: string;
  collection: string;
  environment: "local" | "sandbox" | "production";
  /** Production-level: production tag or any non-loopback host. */
  dangerous: boolean;
}

export function openCollectionTab(p: CollectionTabParams): string {
  const id = openTab({ type: "mongo-collection", id: collectionTabId(p.connectionId, p.db, p.collection), title: p.collection, params: { ...p } });
  retitleCollectionTabs();
  return id;
}

/** Two open tabs with the same collection name on different connections are told apart by the connection name. */
export function retitleCollectionTabs(): void {
  const open = tabs().filter((t) => t.type === "mongo-collection");
  for (const t of open) {
    const mine = t.params as unknown as CollectionTabParams;
    const clash = open.some((o) => o.id !== t.id && (o.params as unknown as CollectionTabParams).collection === mine.collection && (o.params as unknown as CollectionTabParams).connectionId !== mine.connectionId);
    const title = clash ? `${mine.collection} · ${mine.connectionName}` : mine.collection;
    if (t.title !== title) updateTab(t.id, { title });
  }
}

export function openConnectionsTab(action?: ConnectionsAction | boolean): void {
  const a = action === true ? "new" : action || undefined;
  const params = a ? { action: a, nonce: Date.now() } : {};
  openTab({ type: "mongo-connections", id: CONNECTIONS_TAB, title: t("mongoManage.tab.connections"), params });
  // The tab may already be open and unchanged: tell it about the new action.
  if (a) updateTab(CONNECTIONS_TAB, { params });
}

const activeParams = (): CollectionTabParams | undefined => {
  const t = activeTab();
  return t?.type === "mongo-collection" ? (t.params as unknown as CollectionTabParams) : undefined;
};

/** A lazy tab body with its own loading state: the first open of a tab type used to show an empty centre area for seconds. */
function withSkeleton(load: () => Promise<{ default: Component<any> }>): Component<any> {
  const Body = lazy(load);
  return (props) => (
    <Suspense fallback={<div class="mg-tab__boot" role="status" aria-label={t("mongoManage.loading")}><Skeleton height={36} /><Skeleton height={24} width="60%" /><Skeleton height={220} /></div>}>
      <Body {...props} />
    </Suspense>
  );
}

/** Palette keywords are one comma-separated catalog string, so a language can add its own words. */
const kw = (key: Parameters<typeof t>[0]): string[] => t(key).split(",").map((k) => k.trim()).filter(Boolean);

const LoudChipBody = lazy(() => import("./loudChip").then((m) => ({ default: () => <m.LoudChip onClick={() => openConnectionsTab()} /> })));
const LazyLoudChip: Component = () => (
  <Suspense fallback={null}>
    <LoudChipBody />
  </Suspense>
);

/** Connections that are Production-level right now (tag or host rule): quitting with one open asks first. */
const productionOpen = (): ConnectionView[] => (snapshot()?.connections ?? []).filter((c) => c.effectiveLevel === "productionLevel" || c.environment === "production");

let disposers: Disposer[] = [];
let offState: (() => void) | undefined;

function activate(): void {
  if (disposers.length) return;
  offState = ipc.mongo.onState(applyStatus);
  const d = disposers;
  d.push(
    registerTabType({ type: "mongo-collection", title: t("mongoManage.tab.collection"), icon: Table2, canClose: true, component: withSkeleton(() => import("./CollectionTab")) }),
    registerTabType({ type: "mongo-connections", title: t("mongoManage.tab.connections"), icon: Database, canClose: true, component: withSkeleton(() => import("./ConnectionsTab")) }),
    registerRailItem({ id: "mongo", icon: Database, get title() { return t("mongoManage.rail.title"); }, order: 75, position: "left", panel: lazy(() => import("./StudioPanel")) }),
    // The red chip while a production connection is open anywhere (T12's LoudChip); its chunk loads only once the switch is on.
    registerStatusItem({ id: "mongo-danger", align: "left", order: 36, component: LazyLoudChip }),
    // Quitting with a Production-level connection open asks first (the close guard's "session" source); Disconnect and quit ends them with their audit entries.
    registerUnsavedSource({
      id: "mongo-production",
      kind: "session",
      titles: () => productionOpen().map((c) => c.name),
      saveAll: async () => {
        await Promise.all(productionOpen().map((c) => (expectClose(c.id), ipc.mongo.disconnect(c.id).then(() => true, () => false))));
        return true;
      },
      copy: () => {
        const names = productionOpen().map((c) => c.name);
        return { title: t("mongoLoud.close.title", { count: names.length }), description: t("mongoLoud.close.desc", { count: names.length, names: fmt.list(names) }), confirm: t("mongoLoud.close.confirm") };
      },
    }),
    registerCommand({ id: "mongo.newConnection", get title() { return t("mongoManage.cmd.new"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.new"); }, run: () => openConnectionsTab("new") }),
    registerCommand({ id: "mongo.wizard", get title() { return t("mongoManage.cmd.wizard"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.wizard"); }, run: () => openConnectionsTab("wizard") }),
    registerCommand({ id: "mongo.connections", get title() { return t("mongoManage.cmd.manage"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.manage"); }, run: () => openConnectionsTab() }),
    registerCommand({ id: "mongo.import", get title() { return t("mongoManage.cmd.import"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.import"); }, run: () => openConnectionsTab("import") }),
    registerCommand({ id: "mongo.export", get title() { return t("mongoManage.cmd.export"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.export"); }, run: () => openConnectionsTab("export") }),
    registerCommand({ id: "mongo.ask", get title() { return t("mongoManage.cmd.ask"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.ask"); }, shortcut: "Mod+I", when: hasController, run: () => activeController()?.focusAi() }),
    registerCommand({ id: "mongo.run", get title() { return t("mongoManage.cmd.run"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.run"); }, shortcut: "Mod+Shift+Enter", when: hasController, run: () => activeController()?.run() }),
    registerCommand({ id: "mongo.cancel", get title() { return t("mongoManage.cmd.cancel"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.cancel"); }, when: () => !!activeController()?.loading(), run: () => activeController()?.cancel() }),
    registerCommand({ id: "mongo.reset", get title() { return t("mongoManage.cmd.reset"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.reset"); }, when: hasController, run: () => activeController()?.reset() }),
    registerCommand({ id: "mongo.explain", get title() { return t("mongoManage.cmd.explain"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.explain"); }, when: hasController, run: () => activeController()?.explain() }),
    registerCommand({ id: "mongo.refreshSchema", get title() { return t("mongoManage.cmd.schema"); }, get group() { return t("mongoManage.cmd.group"); }, get keywords() { return kw("mongoManage.kw.schema"); }, when: hasController, run: () => activeController()?.refreshSchema() }),
    registerCommand({ id: "mongo.viewTable", get title() { return t("mongoManage.cmd.viewTable"); }, get group() { return t("mongoManage.cmd.group"); }, when: hasController, run: () => activeController()?.setView("table") }),
    registerCommand({ id: "mongo.viewTree", get title() { return t("mongoManage.cmd.viewTree"); }, get group() { return t("mongoManage.cmd.group"); }, when: hasController, run: () => activeController()?.setView("tree") }),
    registerCommand({ id: "mongo.viewJson", get title() { return t("mongoManage.cmd.viewJson"); }, get group() { return t("mongoManage.cmd.group"); }, when: hasController, run: () => activeController()?.setView("json") }),
  );
}

function deactivate(): void {
  for (const off of disposers) off();
  disposers = [];
  offState?.();
  offState = undefined;
  for (const t of tabs()) if (t.type === "mongo-collection" || t.type === "mongo-connections") closeTab(t.id, { force: true });
}

export function applyStatus(s: StudioStatus): void {
  const before = snapshot();
  const active = s.compiled && s.enabled;
  if (active && before) {
    const gone = vanished(before.connections, s.connections, expected);
    for (const id of s.connections.map((c) => c.id)) expected.delete(id);
    if (gone.length) {
      setLost((all) => ({ ...all, ...Object.fromEntries(gone.map((id) => [id, { name: before.connections.find((c) => c.id === id)?.name ?? id, tunnel: before.connections.find((c) => c.id === id)?.tunnel != null }])) }));
    }
    for (const id of s.connections.map((c) => c.id)) clearLost(id);
  } else {
    setLost({});
    expected.clear();
  }
  setSnapshot(s);
  setBuilt(s.compiled);
  setOn(s.compiled && s.enabled);
  if (s.compiled && s.enabled) activate();
  else deactivate();
}

/** One cheap status call at start-up; a build without the feature rejects and the module stays dormant. */
export async function loadStatus(): Promise<void> {
  try {
    applyStatus(await ipc.mongo.status());
  } catch {
    setBuilt(false);
    setOn(false);
  }
}

export async function setStudioEnabled(enabled: boolean): Promise<StudioStatus> {
  const s = await ipc.mongo.setEnabled(enabled);
  applyStatus(s);
  return s;
}

/** Test helper. */
export const resetGate = () => (deactivate(), setOn(false), setBuilt(undefined), setSnapshot(undefined), setLost({}), expected.clear());
