export function elapsed(from: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function countdown(expiresAt: number, now = Date.now()): string {
  const s = Math.round((expiresAt - now) / 1000);
  if (s <= 0) return "expired";
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s left` : `${s}s left`;
}

export const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** Splits a command into highlighted tokens: program, flags, paths, other. */
export function tokens(cmd: string): { text: string; cls: "prog" | "flag" | "path" | "arg" | "op" }[] {
  const parts = cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let first = true;
  return parts.map((text) => {
    if (/^(\|\||&&|\||;|>|>>|<)$/.test(text)) {
      first = true;
      return { text, cls: "op" as const };
    }
    if (first) {
      first = false;
      return { text, cls: "prog" as const };
    }
    if (/^--?[A-Za-z]/.test(text)) return { text, cls: "flag" as const };
    if (/^["']?(\/|~|\.\.?\/|[\w.-]+\/)/.test(text)) return { text, cls: "path" as const };
    return { text, cls: "arg" as const };
  });
}
