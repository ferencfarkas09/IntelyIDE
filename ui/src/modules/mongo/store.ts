import { batch, createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { ConnectionView, ProfileView, SecretKind, SessionSecrets } from "../../ipc/mongo";
import { toEngineError } from "../../ipc/rpc";
import { countOf, listCollections, listDatabases, tabPart, type DbRow } from "./api";
import { noteConnected, studioSnapshot } from "./gate";
import { connIdentity } from "./logic";

// Connection state of the studio: the profiles from Rust, and per connection what the tree needs. "Connected" comes from the
// gateway's own status (so a reload or another window cannot disagree); only "connecting" and "error" live here. Nothing in
// this file holds a connection string.

export type ConnStatus = "idle" | "connecting" | "connected" | "error";

export interface CollEntry {
  name: string;
  /** `estimatedDocumentCount`, filled in after the listing. */
  count?: number;
}

export interface ConnState {
  status: ConnStatus;
  view?: ConnectionView;
  error?: string;
  /** The connect was refused for lack of these secrets (S9 asks for them); empty once they are supplied. */
  needs?: SecretKind[];
  databases?: DbRow[];
  /** Collections per database; "loading" and error objects are kept so the tree can show them. */
  collections: Record<string, CollEntry[] | "loading" | { error: string }>;
}

const [profiles, setProfiles] = createSignal<readonly ProfileView[]>([]);
const [loaded, setLoaded] = createSignal(false);
const [local, setLocal] = createSignal<Record<string, Partial<ConnState> & { transient?: ConnStatus }>>({});
const [loadError, setLoadError] = createSignal<string>();

export { profiles, loaded, loadError };

export const messageOf = (e: unknown): string => String((typeof e === "object" && e && "message" in e ? e : toEngineError(e) as unknown as { message: unknown }).message);
export const codeOf = (e: unknown): string => (typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "io");

export const profileById = (id: string): ProfileView | undefined => profiles().find((p) => p.id === id);

/** Reactive: reads the gateway snapshot and the local cache. */
export function stateOf(id: string): ConnState {
  const view = studioSnapshot()?.connections.find((c) => c.id === id);
  const l = local()[id];
  const status: ConnStatus = view ? "connected" : (l?.transient ?? "idle");
  return { status, view, error: l?.error, needs: l?.needs, databases: view ? l?.databases : undefined, collections: view ? (l?.collections ?? {}) : {} };
}

function patch(id: string, p: Partial<ConnState> & { transient?: ConnStatus }): void {
  setLocal((all) => ({ ...all, [id]: { ...all[id], ...p } }));
}

export async function refreshProfiles(): Promise<void> {
  try {
    setProfiles(await ipc.mongo.profiles());
    setLoadError(undefined);
  } catch (e) {
    setLoadError(messageOf(e));
  } finally {
    setLoaded(true);
  }
}

// --- secrets typed for this session -----------------------------------------------------------------------------------
// A password the user chose not to save (S9 "Remember until I quit") lives here, in memory only, keyed by the profile id and
// the connection identity it was typed for (spec 5.5): when the host, tunnel, mechanism, user name or TLS mode changes the
// entry is dropped, so a secret can never be sent to a destination it was not typed for. It is wiped on switch off, on delete,
// on a changed destination and when a dialog closes. Nothing here touches localStorage, sessionStorage, history or the URL.

type SecretBag = { identity: string; secrets: Record<SecretKind, string> };
const bags = new Map<string, SecretBag>();

const KINDS: SecretKind[] = ["password", "keyPassword", "sshSecret", "proxyPassword"];

/** Overwrites and forgets the bag of one profile, or of all of them. JS strings are immutable: the point is dropping every reference. */
export function wipeSecrets(id?: string): void {
  const doomed = id === undefined ? [...bags.keys()] : [id];
  for (const k of doomed) {
    const b = bags.get(k);
    if (b) for (const kind of KINDS) b.secrets[kind] = "";
    bags.delete(k);
  }
}

export function rememberSecrets(id: string, identity: string, secrets: SessionSecrets): void {
  const old = bags.get(id);
  const bag: SecretBag = old && old.identity === identity ? old : { identity, secrets: { password: "", keyPassword: "", sshSecret: "", proxyPassword: "" } };
  if (old && old !== bag) wipeSecrets(id);
  for (const kind of KINDS) if (secrets[kind]) bag.secrets[kind] = secrets[kind] as string;
  bags.set(id, bag);
}

/** The remembered secrets for this exact destination, or undefined (a bag typed for another destination is wiped on the way). */
export function recallSecrets(id: string, identity: string): SessionSecrets | undefined {
  const b = bags.get(id);
  if (!b) return undefined;
  if (b.identity !== identity) return (wipeSecrets(id), undefined);
  const out: SessionSecrets = {};
  for (const kind of KINDS) if (b.secrets[kind]) out[kind] = b.secrets[kind];
  return Object.keys(out).length ? out : undefined;
}

export const hasRemembered = (id: string): boolean => bags.has(id);

/** The cache key of the secrets typed into one open form or wizard (so a second Test needs no retyping). */
export const dialogScope = (dialogId: string): string => `dialog:${dialogId}`;

/** A form or wizard closed: drop its draft-vault entry in Rust and every secret it cached. */
export function closeDialogSecrets(opts: { dialogId: string; draft?: string | null }): void {
  if (opts.draft) void ipc.mongo.draftDiscard(opts.draft).catch(() => undefined);
  wipeSecrets(dialogScope(opts.dialogId));
}

const identityOfProfile = (p: ProfileView): string | undefined => (p.spec ? connIdentity(p.spec) : undefined);

export function upsertProfile(p: ProfileView): void {
  // A changed destination (host, tunnel, mechanism, user, TLS mode) invalidates what was typed for the old one.
  const identity = identityOfProfile(p);
  if (!identity || bags.get(p.id)?.identity !== identity) wipeSecrets(p.id);
  setProfiles((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]));
  // Saving drops the live session in Rust: forget the cached tree.
  setLocal((all) => {
    const { [p.id]: _drop, ...rest } = all;
    return rest;
  });
}

export function dropProfile(id: string): void {
  wipeSecrets(id);
  setProfiles((all) => all.filter((p) => p.id !== id));
  setLocal((all) => {
    const { [id]: _drop, ...rest } = all;
    return rest;
  });
}

/** `needs:password,sshSecret` in the message of a `mongoNeedSecret` rejection. */
export const needsOf = (e: unknown): SecretKind[] => {
  const m = /needs:\s*([A-Za-z,\s]+)/.exec(messageOf(e));
  return (m?.[1] ?? "").split(/[,\s]+/).filter((k): k is SecretKind => (KINDS as string[]).includes(k));
};

/**
 * Connects. Secrets typed in S9 are passed once (`typed`) and, with `remember`, kept for this session under the profile's
 * current identity; later connects reuse them. A refusal for a missing secret leaves the profile in the idle state with
 * `needs` set (the prompt, not an error banner). A remembered secret that the server rejects is dropped, so the prompt
 * reappears once and never loops.
 */
export async function connect(id: string, typed?: { secrets: SessionSecrets; remember: boolean }): Promise<boolean> {
  if (stateOf(id).status === "connected") return true;
  patch(id, { transient: "connecting", error: undefined, needs: undefined });
  const p = profileById(id);
  const identity = p ? identityOfProfile(p) : undefined;
  const secrets = typed?.secrets ?? (identity ? recallSecrets(id, identity) : undefined);
  try {
    const view = await ipc.mongo.connect(id, secrets);
    noteConnected(view);
    if (typed?.remember && identity) rememberSecrets(id, identity, typed.secrets);
    patch(id, { transient: undefined, error: undefined, needs: undefined });
    const dbs = await listDatabases(id);
    patch(id, { databases: dbs });
    return true;
  } catch (e) {
    if (codeOf(e) === "mongoNeedSecret") {
      patch(id, { transient: undefined, error: undefined, needs: needsOf(e) });
      return false;
    }
    if (/auth(entication)?[ .]?(failed)?|sign-in/i.test(messageOf(e))) wipeSecrets(id);
    patch(id, { transient: "error", error: messageOf(e), needs: undefined });
    return false;
  }
}

export async function disconnect(id: string): Promise<void> {
  try {
    await ipc.mongo.disconnect(id);
  } finally {
    setLocal((all) => {
      const { [id]: _drop, ...rest } = all;
      return rest;
    });
  }
}

/** Lists a database's collections, then fills in estimated counts in the background (at most 60, four at a time). */
export async function loadCollections(id: string, db: string, force = false): Promise<void> {
  const cur = local()[id]?.collections?.[db];
  if (!force && (cur === "loading" || Array.isArray(cur))) return;
  const put = (v: CollEntry[] | "loading" | { error: string }) => patch(id, { collections: { ...local()[id]?.collections, [db]: v } });
  put("loading");
  try {
    const rows = await listCollections(id, db);
    const entries: CollEntry[] = rows.map((r) => ({ name: r.name }));
    put(entries);
    const todo = entries.slice(0, 60);
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(
        todo.slice(i, i + 4).map(async (e) => {
          try {
            e.count = (await countOf(id, `${tabPart(id, 30)}-${tabPart(e.name, 20)}`, db, e.name)).value;
          } catch {
            /* a view or a restricted user: no count */
          }
        }),
      );
      const now = local()[id]?.collections?.[db];
      if (Array.isArray(now)) put(now.map((c) => ({ ...c, count: entries.find((e) => e.name === c.name)?.count ?? c.count })));
    }
  } catch (e) {
    put({ error: messageOf(e) });
  }
}

/** Forget everything (the master switch went off). */
export function resetStore(): void {
  wipeSecrets();
  batch(() => {
    setProfiles([]);
    setLoaded(false);
    setLocal({});
    setLoadError(undefined);
  });
}
