// Pure rules of the connection manager: grouping and search, the chips of a card, which endpoints a profile reaches, and the
// small decisions of the connect flow. No Solid, no ipc: everything here is unit-tested.
import type { ConnSpec, Environment, ProfileView, SecretKind } from "../../../ipc/mongo";
import { isLoopback } from "../form/model";
import { specHosts } from "../logic";

export { vanished } from "./lost";

/** Typed to confirm "reset everything" (spec 5.6). Not translated: the user types exactly this. */
export const RESET_PHRASE = "reset mongo";

export type TagFilter = "all" | Environment;

export interface Section {
  key: string;
  kind: "favorites" | "group" | "none";
  group?: string;
  items: ProfileView[];
}

export function matchesQuery(p: Pick<ProfileView, "name" | "host" | "environment" | "group">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${p.name} ${p.host} ${p.environment} ${p.group ?? ""}`.toLowerCase().includes(q);
}

const byName = (a: ProfileView, b: ProfileView) => a.name.localeCompare(b.name);

/** Favourites on top, then one section per group (A to Z), then the ungrouped. A favourite is listed once, in the favourites section. */
export function sectionsOf(list: readonly ProfileView[], opts: { query?: string; tag?: TagFilter } = {}): Section[] {
  const shown = list.filter((p) => matchesQuery(p, opts.query ?? "") && (!opts.tag || opts.tag === "all" || p.environment === opts.tag));
  const out: Section[] = [];
  const favs = shown.filter((p) => p.favorite).sort(byName);
  if (favs.length) out.push({ key: "favorites", kind: "favorites", items: favs });
  const rest = shown.filter((p) => !p.favorite);
  const groups = [...new Set(rest.map((p) => p.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b));
  for (const g of groups) out.push({ key: `g:${g}`, kind: "group", group: g, items: rest.filter((p) => p.group === g).sort(byName) });
  const none = rest.filter((p) => !p.group).sort(byName);
  if (none.length) out.push({ key: "none", kind: "none", items: none });
  return out;
}

export const allGroups = (list: readonly ProfileView[]): string[] => [...new Set(list.map((p) => p.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b));

export const toggled = (set: readonly string[], key: string): string[] => (set.includes(key) ? set.filter((k) => k !== key) : [...set, key]);

export interface CardChips {
  tunnel?: "ssh" | "socks5";
  tls: "on" | "off" | "auto";
  preset: "generic" | "happy";
}

export function chipsOf(p: Pick<ProfileView, "spec" | "domain">): CardChips {
  const tunnel = p.spec?.tunnel?.kind;
  return { tunnel: tunnel === "ssh" || tunnel === "socks5" ? tunnel : undefined, tls: p.spec?.tls?.mode ?? "auto", preset: p.domain === "happy" ? "happy" : "generic" };
}

/** `host:port` of the database hosts, the bastion and the proxy: every place a connect reaches (the import preview lists the same). */
export function endpointsOf(spec: ConnSpec | null | undefined): string[] {
  if (!spec) return [];
  const out = specHosts(spec).map((h) => (/:\d+$/.test(h) || spec.scheme === "srv" ? h : `${h}:27017`));
  const tun = spec.tunnel;
  if (tun?.kind === "ssh") out.push(`${tun.host}:${tun.port ?? 22}`);
  if (tun?.kind === "socks5") out.push(`${tun.host}:${tun.port}`);
  return [...new Set(out)];
}

/**
 * The first connect of a profile that was never used asks for a confirmation listing its endpoints when it can reach beyond a
 * plain loopback database: a tunnel or proxy, PLAIN, TLS off, or a non-loopback host. Default button: Cancel.
 */
export function needsEndpointConfirm(p: Pick<ProfileView, "spec" | "lastUsedMs">): boolean {
  if (p.lastUsedMs != null || !p.spec) return false;
  const s = p.spec;
  const tunnelled = (s.tunnel?.kind ?? "none") !== "none";
  const remote = (s.hosts ?? []).some((h) => !isLoopback(h.host)) || s.scheme === "srv";
  return tunnelled || s.auth?.mechanism === "plain" || s.tls?.mode === "off" || remote;
}

/** A rejected sign-in (the store matches the same words to drop a remembered secret). */
export const isAuthFailure = (message: string | undefined): boolean => /auth(entication)?[ .]?(failed)?|sign-in/i.test(message ?? "");

export const SECRET_KINDS: SecretKind[] = ["password", "keyPassword", "sshSecret", "proxyPassword"];

/** Note codes that have a sentence in the `mongoForm` catalog (`mongoForm.note.<code>`); anything else reads as "was not applied". */
export const NOTE_CODES = ["authMechanism", "authMechanismProperties", "autoEncryption", "duplicate", "gssapi", "ignoredReadOnly", "placeholderPassword", "placeholderUsername", "proxy", "relativePath", "tlsRelaxRequested", "unknownCompressor", "unknownOption", "unsupportedInBuild"] as const;
export const noteKnown = (code: string): boolean => (NOTE_CODES as readonly string[]).includes(code);

/** Selected rows of an import preview, as indexes for `profilesImport`. */
export const selectedIndexes = (checked: readonly boolean[]): number[] => checked.flatMap((c, i) => (c ? [i] : []));
