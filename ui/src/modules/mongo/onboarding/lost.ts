// Kept import-free: the gate (loaded while the studio is off) uses it.

/** Connections that vanished from the gateway's list without the user asking (tunnel died, network or sleep). */
export function vanished(prev: readonly { id: string }[], now: readonly { id: string }[], expected: ReadonlySet<string>): string[] {
  const alive = new Set(now.map((c) => c.id));
  return prev.map((c) => c.id).filter((id) => !alive.has(id) && !expected.has(id));
}

