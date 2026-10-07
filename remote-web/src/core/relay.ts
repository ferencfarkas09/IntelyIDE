// A thin wrapper over the relay WebSocket (remote-relay/README.md "Wire protocol"): subprotocols `intely.v1, <credential>`
// (never the URL), an immediate and a 25 s text `ping`, binary frames are ciphertext, text frames are plaintext control.
export interface RelayControl {
  t: string;
  [k: string]: unknown;
}

export interface RelayHandlers {
  onOpen?(): void;
  onControl?(c: RelayControl): void;
  onFrame?(bytes: Uint8Array): void;
  onClose?(code: number): void;
}

export type WsCtor = new (url: string, protocols?: string | string[]) => WebSocket;

export const PING_MS = 25_000;

export class RelaySocket {
  private ws: WebSocket;
  private timer: ReturnType<typeof setInterval> | null = null;
  lastRx = Date.now();
  closed = false;

  constructor(url: string, credential: string, private readonly h: RelayHandlers, Ctor: WsCtor = WebSocket) {
    this.ws = new Ctor(url, ["intely.v1", credential]);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      this.ws.send("ping"); // also lets the relay complete a server-initiated close of an otherwise silent socket
      this.timer = setInterval(() => this.ws.readyState === 1 && this.ws.send("ping"), PING_MS);
      h.onOpen?.();
    };
    this.ws.onmessage = (e) => {
      this.lastRx = Date.now();
      if (typeof e.data === "string") {
        if (e.data === "pong") return;
        try {
          const c = JSON.parse(e.data);
          if (c && typeof c.t === "string") h.onControl?.(c);
        } catch {
          /* ignore garbage */
        }
      } else h.onFrame?.(new Uint8Array(e.data as ArrayBuffer));
    };
    this.ws.onclose = (e) => this.end(e.code);
    this.ws.onerror = () => {
      /* followed by close */
    };
  }

  private end(code: number): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.h.onClose?.(code);
  }

  get open(): boolean {
    return this.ws.readyState === 1;
  }

  sendFrame(bytes: Uint8Array): boolean {
    if (!this.open) return false;
    this.ws.send(bytes as Uint8Array<ArrayBuffer>);
    return true;
  }

  sendControl(c: RelayControl): boolean {
    if (!this.open) return false;
    this.ws.send(JSON.stringify(c));
    return true;
  }

  /** Closes without telling the handlers (the caller already knows). */
  close(code = 1000): void {
    this.h.onClose = undefined;
    this.h.onFrame = undefined;
    this.h.onControl = undefined;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try {
      this.ws.close(code);
    } catch {
      /* already closed */
    }
  }
}

/** `ws(s)://` base of the page's own origin: the PWA only ever talks to the relay that served it. */
export function wsBase(loc: Pick<Location, "protocol" | "host"> = location): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}`;
}
