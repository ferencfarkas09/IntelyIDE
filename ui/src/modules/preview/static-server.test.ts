// @vitest-environment node
// The mock preview Ipc against a real fixture static server on an ephemeral loopback port: the probe tells a listening
// server from a closed port, the gate refuses everything that is not literal loopback, and nothing leaves the machine.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPreview } from "../../ipc/mock/preview";
import { validatePreviewUrl } from "./logic";

// tsc runs here without Node types, so the Node module is typed by hand (the test itself runs in the node environment).
interface NodeServer {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number };
  close(cb?: () => void): void;
}
interface NodeHttp {
  createServer(handler: (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(body: string): void }) => void): NodeServer;
}
const { createServer } = (await import(/* @vite-ignore */ ["node", "http"].join(":"))) as NodeHttp;
type Server = NodeServer;

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function serve(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>fixture</title><h1>${req.url}</h1>`);
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, hits })));
}

describe("mock preview against a fixture static server", () => {
  it("probes a listening server as reachable and a closed port as not", async () => {
    const preview = createMockPreview({ timeoutMs: 1500 });
    const { port, hits } = await serve();
    const up = await preview.probe(`http://127.0.0.1:${port}/auth/login`);
    expect(up).toMatchObject({ reachable: true, port });
    expect(hits).toEqual(["/"]);
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    expect((await preview.probe(`http://127.0.0.1:${port}/`)).reachable).toBe(false);
  });

  it("accepts the server's address and normalises it", async () => {
    const preview = createMockPreview();
    const { port } = await serve();
    expect(await preview.checkUrl(`localhost:${port}/crm/leads`)).toEqual({ url: `http://localhost:${port}/crm/leads`, host: "localhost", port, origin: `http://localhost:${port}` });
    const r = validatePreviewUrl(`${port}`);
    expect(r.ok && r.url).toBe(`http://localhost:${port}/`);
  });

  it("refuses non-loopback and rebinding addresses before any request is made", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const preview = createMockPreview();
    const { port } = await serve();
    for (const bad of [`http://127.0.0.1.nip.io:${port}/`, `http://localtest.me:${port}/`, `http://example.com:${port}/`, `https://127.0.0.1:${port}/`, `file:///etc/passwd`, `http://user@127.0.0.1:${port}/`, "http://localhost:1420/"]) {
      await expect(preview.probe(bad), bad).rejects.toMatchObject({ code: expect.any(String) });
      await expect(preview.checkUrl(bad), bad).rejects.toMatchObject({ code: expect.any(String) });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("only ever connects to the loopback origin it validated", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const preview = createMockPreview({ timeoutMs: 800 });
    const { port } = await serve();
    await preview.probe(`http://localhost:${port}/x`);
    for (const [url] of fetch.mock.calls) expect(String(url)).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/);
  });

  it("opens only a validated address and reports it to the caller", async () => {
    const opened: string[] = [];
    const preview = createMockPreview({ onOpen: (u) => opened.push(u) });
    await preview.openExternal("8082");
    await expect(preview.openExternal("http://evil.com")).rejects.toMatchObject({ code: "notLoopback" });
    expect(opened).toEqual(["http://localhost:8082/"]);
  });

  it("lets a test decide reachability by port", async () => {
    const preview = createMockPreview({ reachable: (p) => p === 8082 });
    expect((await preview.probe("8082")).reachable).toBe(true);
    expect((await preview.probe("8083")).reachable).toBe(false);
  });
});
