import { batch, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Button, Copy, Database, EmptyState, IconButton, Input, Lock, Plus, Plug, RefreshCw, Search, Server, Skeleton, Table2, toast, Tree, TreeRow, Unplug, EnvPill } from "../../ui-kit";
import { t } from "../../i18n";
import type { ProfileView } from "../../ipc/mongo";
import type { DbRow } from "./api";
import { openConnectionsTab } from "./gate";
import { formatCount, isDangerous, shownEnv } from "./logic";
import { createConnector } from "./onboarding/connector";
import { openCollection } from "./open";
import { disconnect, loadCollections, loaded, loadError, profiles, refreshProfiles, stateOf } from "./store";
import type { CollEntry } from "./store";
import "./mongo.css";

type Node =
  | { kind: "conn"; key: string; depth: 0; p: ProfileView }
  | { kind: "db"; key: string; depth: 1; p: ProfileView; db: DbRow }
  | { kind: "coll"; key: string; depth: 2; p: ProfileView; db: string; c: CollEntry }
  | { kind: "note"; key: string; depth: number; text: string; tone?: "danger" };

const connKey = (id: string) => `c:${id}`;
const dbKey = (id: string, db: string) => `d:${id}/${db}`;

/** Left tool window: connections > databases > collections, with a filter and a roving-cursor keyboard model. */
export default function StudioPanel() {
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const [cursor, setCursor] = createSignal<string>("");
  const [query, setQuery] = createSignal("");
  const connector = createConnector();
  onMount(() => void refreshProfiles());

  const isOpen = (k: string) => open().has(k);
  const toggleKey = (k: string, force?: boolean) =>
    setOpen((s) => {
      const n = new Set(s);
      if (force ?? !n.has(k)) n.add(k);
      else n.delete(k);
      return n;
    });

  const nodes = createMemo<Node[]>(() => {
    const out: Node[] = [];
    const q = query().trim().toLowerCase();
    for (const p of profiles()) {
      const st = stateOf(p.id);
      const ck = connKey(p.id);
      out.push({ kind: "conn", key: ck, depth: 0, p });
      if (!isOpen(ck) && !q) continue;
      if (st.status === "connecting") out.push({ kind: "note", key: `${ck}/n`, depth: 1, text: t("mongoLoud.panel.connecting") });
      else if (st.status === "error") out.push({ kind: "note", key: `${ck}/n`, depth: 1, text: st.error ?? t("mongoLoud.tab.couldNotConnect"), tone: "danger" });
      else if (st.status === "idle") out.push({ kind: "note", key: `${ck}/n`, depth: 1, text: t("mongoLoud.panel.pressEnter") });
      for (const db of st.databases ?? []) {
        const dk = dbKey(p.id, db.name);
        const colls = st.collections[db.name];
        const matching = Array.isArray(colls) ? colls.filter((c) => !q || c.name.toLowerCase().includes(q) || db.name.toLowerCase().includes(q)) : [];
        if (q && Array.isArray(colls) && !matching.length) continue;
        out.push({ kind: "db", key: dk, depth: 1, p, db });
        if (!isOpen(dk) && !q) continue;
        if (colls === "loading" || colls === undefined) out.push({ kind: "note", key: `${dk}/n`, depth: 2, text: t("mongoLoud.panel.loadingCollections") });
        else if (!Array.isArray(colls)) out.push({ kind: "note", key: `${dk}/n`, depth: 2, text: colls.error, tone: "danger" });
        else if (!colls.length) out.push({ kind: "note", key: `${dk}/n`, depth: 2, text: t("mongoLoud.panel.noCollections") });
        else for (const c of matching) out.push({ kind: "coll", key: `${dk}/${c.name}`, depth: 2, p, db: db.name, c });
      }
    }
    return out;
  });

  async function expandConn(p: ProfileView) {
    const k = connKey(p.id);
    toggleKey(k, true);
    if (stateOf(p.id).status === "connected" || (await connector.start(p))) {
      const dbs = stateOf(p.id).databases ?? [];
      const first = dbs.find((d) => !["admin", "config", "local"].includes(d.name)) ?? dbs[0];
      if (first) {
        toggleKey(dbKey(p.id, first.name), true);
        void loadCollections(p.id, first.name);
      }
    } else if (stateOf(p.id).error) toast.error(t("mongoLoud.tab.connectFailed", { name: p.name }), stateOf(p.id).error);
  }

  function expandDb(p: ProfileView, name: string) {
    toggleKey(dbKey(p.id, name), true);
    void loadCollections(p.id, name);
  }

  function activate(n: Node) {
    if (n.kind === "conn") return isOpen(n.key) && stateOf(n.p.id).status === "connected" ? toggleKey(n.key, false) : void expandConn(n.p);
    if (n.kind === "db") return isOpen(n.key) ? toggleKey(n.key, false) : expandDb(n.p, n.db.name);
    if (n.kind === "coll") openCollection(n.p, n.db, n.c.name);
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = nodes();
    const at = Math.max(0, list.findIndex((n) => n.key === cursor()));
    const n = list[at];
    const go = (i: number) => {
      const t = list[Math.min(Math.max(i, 0), list.length - 1)];
      if (!t) return;
      setCursor(t.key);
      queueMicrotask(() => (e.currentTarget as HTMLElement).querySelector(`[data-key="${CSS.escape(t.key)}"]`)?.scrollIntoView?.({ block: "nearest" }));
    };
    switch (e.key) {
      case "ArrowDown": return (e.preventDefault(), go(at + 1));
      case "ArrowUp": return (e.preventDefault(), go(at - 1));
      case "Home": return (e.preventDefault(), go(0));
      case "End": return (e.preventDefault(), go(list.length - 1));
      case "ArrowRight":
        if (!n || n.kind === "coll" || n.kind === "note") return;
        e.preventDefault();
        if (!isOpen(n.key)) return activate(n);
        return go(at + 1);
      case "ArrowLeft":
        if (!n) return;
        e.preventDefault();
        if ((n.kind === "conn" || n.kind === "db") && isOpen(n.key)) return toggleKey(n.key, false);
        for (let i = at - 1; i >= 0; i--) if (list[i].depth < n.depth) return go(i);
        return;
      case "Enter":
      case " ":
        if (n) (e.preventDefault(), activate(n));
    }
  }

  const aria = (n: Node) => (n.kind === "note" ? undefined : isOpen(n.key) || !!query().trim());

  return (
    <section class="mg-panel" aria-label={t("mongoLoud.panel.title")}>
      <header class="mg-panel__head">
        <span class="mg-panel__title">{t("mongoLoud.panel.title")}</span>
        <IconButton icon={RefreshCw} label={t("mongoLoud.panel.reload")} size="sm" onClick={() => void refreshProfiles()} />
        <IconButton icon={Plus} label={t("mongoLoud.panel.new")} size="sm" onClick={() => openConnectionsTab(true)} />
        <IconButton icon={Server} label={t("mongoLoud.panel.manage")} size="sm" onClick={() => openConnectionsTab()} />
      </header>
      <div class="mg-panel__filter">
        <Input size="sm" aria-label={t("mongoLoud.panel.filter")} placeholder={t("mongoLoud.panel.filter")} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} leading={<Search size={14} />} />
      </div>
      <div class="mg-panel__body">
        <Show when={loaded()} fallback={<div class="mg-panel__skeleton"><Skeleton height={20} /><Skeleton height={20} width="70%" /><Skeleton height={20} width="85%" /></div>}>
          <Show when={!loadError()} fallback={<EmptyState tone="danger" size="sm" icon={Database} title={t("mongoLoud.panel.loadFailed")} description={loadError()} action={<Button size="sm" onClick={() => void refreshProfiles()}>{t("mongoLoud.tab.retry")}</Button>} />}>
            <Show when={profiles().length > 0} fallback={<EmptyState size="sm" icon={Database} title={t("mongoLoud.panel.noneTitle")} description={t("mongoLoud.panel.noneDesc")} action={<Button size="sm" variant="primary" icon={Plus} onClick={() => openConnectionsTab(true)}>{t("mongoLoud.panel.new")}</Button>} />}>
              <Tree aria-label={t("mongoLoud.panel.treeAria")} onKeyDown={onKeyDown} tabIndex={0} class="mg-tree" onFocus={() => !cursor() && nodes()[0] && setCursor(nodes()[0].key)}>
                <For each={nodes()}>
                  {(n) => (
                    <Show
                      when={n.kind !== "note"}
                      fallback={<div class="mg-tree__note" data-tone={(n as Extract<Node, { kind: "note" }>).tone} style={{ "--depth": n.depth }} role="treeitem" aria-level={n.depth + 1} aria-selected="false">{(n as Extract<Node, { kind: "note" }>).text}</div>}
                    >
                      <Row n={n} cursor={cursor() === n.key} open={!!aria(n)} onPick={() => (setCursor(n.key), activate(n))} onToggle={() => batch(() => (setCursor(n.key), activate(n)))} onConnect={(p) => void expandConn(p)} />
                    </Show>
                  )}
                </For>
              </Tree>
            </Show>
          </Show>
        </Show>
      </div>
      {connector.dialogs()}
    </section>
  );
}

function Row(props: { n: Node; cursor: boolean; open: boolean; onPick: () => void; onToggle: () => void; onConnect: (p: ProfileView) => void }) {
  const n = () => props.n;
  return (
    <>
      <Show when={n().kind === "conn" ? (n() as Extract<Node, { kind: "conn" }>) : undefined} keyed>
        {(c) => {
          const st = () => stateOf(c.p.id);
          return (
            <TreeRow
              compact={false}
              depth={0}
              data-key={c.key}
              class="mg-tree__conn"
              data-danger={isDangerous(c.p) ? "" : undefined}
              style={{ "--edge": c.p.color || "var(--border-strong)" }}
              expanded={props.open}
              cursor={props.cursor}
              onToggle={props.onToggle}
              onClick={props.onPick}
              leading={<span class="mg-dot" data-state={st().status} aria-hidden="true" />}
              trailing={<span class="mg-tree__meta"><Show when={st().status === "connected"}><Lock size={11} aria-label={t("mongoLoud.tab.readOnly")} /></Show><EnvPill env={shownEnv(c.p)} size="sm" /></span>}
              actions={
                <IconButton
                  icon={st().status === "connected" ? Unplug : Plug}
                  label={st().status === "connected" ? t("mongoLoud.panel.disconnect") : t("mongoLoud.panel.connect")}
                  size="sm"
                  tabIndex={-1}
                  onClick={(e) => (e.stopPropagation(), st().status === "connected" ? void disconnect(c.p.id) : props.onConnect(c.p))}
                />
              }
            >
              {c.p.name}
            </TreeRow>
          );
        }}
      </Show>
      <Show when={n().kind === "db" ? (n() as Extract<Node, { kind: "db" }>) : undefined} keyed>
        {(d) => (
          <TreeRow depth={1} data-key={d.key} expanded={props.open} cursor={props.cursor} onToggle={props.onToggle} onClick={props.onPick} leading={<Database size={13} />}>
            {d.db.name}
          </TreeRow>
        )}
      </Show>
      <Show when={n().kind === "coll" ? (n() as Extract<Node, { kind: "coll" }>) : undefined} keyed>
        {(c) => (
          <TreeRow
            depth={2}
            data-key={c.key}
            cursor={props.cursor}
            onClick={props.onPick}
            leading={<Table2 size={13} />}
            trailing={<Show when={c.c.count !== undefined}><span class="mg-tree__meta ui-tnum" title={t("mongoLoud.panel.estimated", { n: c.c.count! })}>{formatCount(c.c.count!, false)}</span></Show>}
            actions={<IconButton icon={Copy} label={t("mongoLoud.panel.copyName")} size="sm" tabIndex={-1} onClick={(e) => (e.stopPropagation(), void navigator.clipboard?.writeText(c.c.name).then(() => toast.info(t("mongoLoud.panel.nameCopied"))))} />}
          >
            {c.c.name}
          </TreeRow>
        )}
      </Show>
    </>
  );
}
