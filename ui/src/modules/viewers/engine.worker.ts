// Worker entry: parsing a 50 MB document must not freeze the window.
import { EngineHost } from "./host";

const host = new EngineHost();

self.onmessage = (ev: MessageEvent<{ id: number; op: string; args: unknown[] }>) => {
  const { id, op, args } = ev.data;
  try {
    (self as unknown as Worker).postMessage({ id, result: host.dispatch(op, args) });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
