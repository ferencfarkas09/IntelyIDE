// Shared helpers for the mock-happy node tests (not a test file): an HTTP client, a raw Socket.IO client, id constants.
import { createMockHappy, listen, MOCK_TOKEN } from "./server.mjs";

export { MOCK_TOKEN };
export const ME = "5f0000000000000000000001";
export const ANNA = "5f0000000000000000000002";
export const PETER = "5f0000000000000000000003";
export const BELA = "5f0000000000000000000004";
export const DORA = "5f0000000000000000000005";
export const GENERAL = "5f1000000000000000000001";
export const OPS = "5f1000000000000000000002";
export const RANDOM = "5f1000000000000000000003";
export const DM = "5f1000000000000000000004";
export const GROUP = "5f1000000000000000000005";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startMock() {
  const server = createMockHappy();
  const base = `http://127.0.0.1:${await listen(server)}`;
  const hasSockets = (await server.socketReady) === true;
  const api = async (method, path, body, token = MOCK_TOKEN) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const reset = () => api("POST", "/__mock/reset");
  const control = (path, body) => api("POST", `/__mock/chat/${path}`, body ?? {}).then((r) => r.json);

  /** A raw Socket.IO client: connects, authenticates with the token and joins the user room. */
  async function connect({ token = MOCK_TOKEN, userId = ME, join = true } = {}) {
    const ws = new WebSocket(`${base.replace("http", "ws")}/socket.io/?EIO=4&transport=websocket`);
    const frames = [];
    let closed = false;
    ws.onmessage = (m) => {
      const f = String(m.data);
      if (f === "2") ws.send("3");
      frames.push(f);
    };
    ws.onclose = () => (closed = true);
    const waitFor = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await sleep(15);
      }
      throw new Error(`timed out; frames so far: ${JSON.stringify(frames)}`);
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("socket error"));
    });
    const open = JSON.parse((await waitFor((f) => f.startsWith("0"))).slice(1));
    ws.send(`40${JSON.stringify({ token, userId, name: "Teszt Elek" })}`);
    const ack = await waitFor((f) => f.startsWith("40") || f.startsWith("44"));
    if (join && ack.startsWith("40")) ws.send(`42${JSON.stringify(["join:user", userId])}`);
    const events = (name) => frames.filter((f) => f.startsWith("42")).map((f) => JSON.parse(f.slice(2))).filter((e) => e[0] === name).map((e) => e[1]);
    const waitEvent = (name, pred = () => true, ms = 3000) => waitFor(() => events(name).some(pred), ms).then(() => events(name).filter(pred));
    return { ws, frames, ack, open, waitFor, events, waitEvent, isClosed: () => closed, close: () => ws.close() };
  }
  return { server, base, hasSockets, api, reset, control, connect, close: () => server.close() };
}
