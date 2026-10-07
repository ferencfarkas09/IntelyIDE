// wrangler dev on loopback with the built PWA as the static assets (remote-relay/tests/harness.mjs is the model). Never contacts
// Cloudflare: no CLOUDFLARE_* variables, metrics off, `--local`, persistence in a temp dir, host pinned to 127.0.0.1.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const webRoot = join(here, "../..");
const relayRoot = join(webRoot, "../remote-relay");

export interface Relay {
  base: string;
  host: string;
  dist: string;
  log(): string;
  stop(): Promise<void>;
}

export async function startRelay(opts: { port?: number } = {}): Promise<Relay> {
  const port = opts.port ?? 20000 + Math.floor(Math.random() * 20000);
  const tmp = mkdtempSync(join(tmpdir(), "intely-web-relay-"));
  const dist = join(tmp, "pwa");
  cpSync(join(webRoot, "dist"), dist, { recursive: true }); // the signed build, byte for byte
  const args = ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(tmp, "state"), "--assets", dist, "--inspector-port", "0", "--var", "JOIN_RATE_PER_MIN:1000"];
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(tmp, "xdg"),
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(tmp, "logs"),
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_HIDE_BANNER: "true",
  } as NodeJS.ProcessEnv;
  const child: ChildProcess = spawn(join(relayRoot, "node_modules/.bin/wrangler"), args, { cwd: relayRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error("wrangler exited early:\n" + log.slice(-2000));
    if (Date.now() - t0 > 240_000) {
      child.kill();
      throw new Error("wrangler start timeout:\n" + log.slice(-2000));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    base,
    host: `127.0.0.1:${port}`,
    dist,
    log: () => log,
    async stop() {
      child.kill("SIGTERM");
      await new Promise<void>((res) => {
        const t = setTimeout(() => (child.kill("SIGKILL"), res()), 5000);
        child.on("exit", () => (clearTimeout(t), res()));
      });
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
