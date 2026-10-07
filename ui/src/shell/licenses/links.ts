/** Which dependency-supplied links may open in the system browser ((design notes: licensing-spec) 9.1). Others stay copyable text. */
const BASE_HOSTS = ["gnu.org", "github.com", "crates.io", "npmjs.com", "docs.rs"];

export interface LinkAction {
  action: "open" | "copy";
  hostname: string;
  url: string;
}

const hostAllowed = (host: string, allow: readonly string[]) => allow.some((h) => host === h || host.endsWith(`.${h}`));

/** Returns null for anything that is not a plain https URL with a hostname (javascript:, file:, http:, userinfo, too long). */
export function linkAction(raw: string, extraHosts: readonly string[] = []): LinkAction | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  const hostname = u.hostname.toLowerCase();
  return { action: hostAllowed(hostname, [...BASE_HOSTS, ...extraHosts.map((h) => h.toLowerCase())]) ? "open" : "copy", hostname, url: u.toString() };
}
