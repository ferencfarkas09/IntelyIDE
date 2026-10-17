import releasesData from "./releases.json";

/** The two languages the notes are written in; every other language reads the English text, like the catalogs that are not translated yet. */
export type Localized = { en: string; hu: string };
export type NoteKind = "new" | "improved" | "fixed";
export interface Note {
  kind: NoteKind;
  title: Localized;
  text: Localized;
}
export interface Release {
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
  headline: Localized;
  notes: Note[];
}

/** What changed in each release, newest first. Written for people, not copied from the changelog: a few lines each, in plain words. */
export const RELEASES: readonly Release[] = releasesData as Release[];

/** Most releases the window lists when somebody skipped several. */
export const MAX_RELEASES = 4;

const parts = (version: string): number[] => (/^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : [0, 0, 0]);

/** Negative when `a` is older than `b`; a version that is not `X.Y.Z` counts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The text in the reader's language: Hungarian for any `hu` locale, English otherwise. */
export const pick = (text: Localized, lang: string): string => (lang.toLowerCase().startsWith("hu") ? text.hu : text.en);

/**
 * The releases to list: everything newer than the one the person last saw, up to the running version, newest first (at most
 * `max`). Without a last-seen version only the running release is listed.
 */
export function releasesToShow(all: readonly Release[], seen: string | undefined, current: string, max = MAX_RELEASES): Release[] {
  const upToNow = [...all].filter((r) => compareVersions(r.version, current) <= 0).sort((a, b) => compareVersions(b.version, a.version));
  if (!seen) return upToNow.slice(0, 1);
  return upToNow.filter((r) => compareVersions(r.version, seen) > 0).slice(0, max);
}

export type Decision = "show" | "remember" | "none";

export interface DecisionInput {
  /** The version of the last window the person closed. */
  seen: string | undefined;
  /** The running version; undefined outside the desktop app. */
  current: string | undefined;
  /** The workspace registry is empty: this is a first start and the Welcome screen is up. */
  freshInstall: boolean;
  /** The app runs without the read-only or test jail (a dev run or a test harness is not an update). */
  jailOff: boolean;
  /** How many releases `releasesToShow` found. */
  news: number;
}

/**
 * What to do at start. `show`: the app was updated and has something to tell. `remember`: nothing to show, but the running version is
 * written down, so a later update is compared with it (a first start, a downgrade, an update whose release has no notes).
 */
export function decide(i: DecisionInput): Decision {
  if (!i.current || !i.jailOff) return "none";
  if (i.seen === i.current) return "none";
  if (i.freshInstall && i.seen === undefined) return "remember";
  if (i.seen !== undefined && compareVersions(i.seen, i.current) > 0) return "remember";
  return i.news > 0 ? "show" : "remember";
}
