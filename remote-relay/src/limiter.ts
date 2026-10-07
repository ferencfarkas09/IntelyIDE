import { DurableObject } from "cloudflare:workers";

/** Per-IP join/create attempt limiter. One instance per hashed IP; in-memory fixed window (resetting on eviction is acceptable). */
export class JoinLimiter extends DurableObject {
  private start = 0;
  private count = 0;
  async hit(limit: number): Promise<boolean> {
    const now = Date.now();
    if (now - this.start > 60_000) { this.start = now; this.count = 0; }
    return ++this.count <= limit;
  }
  /** Liveness probe for /api/status: proves the Durable Object runtime answers. Touches no storage and no counter. */
  async ping(): Promise<boolean> {
    return true;
  }
}
