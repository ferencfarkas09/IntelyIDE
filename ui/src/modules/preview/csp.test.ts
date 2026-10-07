// Guards of the preview's security posture: the CSP carries exactly the two loopback frame sources, nothing else was
// widened, and no capability gives a remote origin (such as the frame's) access to Tauri commands.
import { describe, expect, it } from "vitest";
import conf from "../../../../src-tauri/tauri.conf.json?raw";
import { FRAME_SANDBOX, FRAME_SRC, LOOPBACK_HOSTS } from "./logic";

const capabilities = import.meta.glob("../../../../src-tauri/capabilities/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const config = JSON.parse(conf) as { app: { withGlobalTauri?: boolean; security: { csp: string; [k: string]: unknown } } };
const directives = (csp: string): Map<string, string[]> =>
  new Map(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...sources] = d.split(/\s+/);
        return [name, sources] as const;
      }),
  );
const csp = directives(config.app.security.csp);

/** Every source the IDE's own policy may contain. A new origin anywhere fails the test below and needs a deliberate edit here. */
const ALLOWED: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "font-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "connect-src": ["'self'", "ipc:", "http://ipc.localhost"],
  "frame-src": ["http://127.0.0.1:*", "http://localhost:*"],
};

describe("content security policy", () => {
  it("has a frame-src with exactly the two loopback sources", () => {
    expect([...(csp.get("frame-src") ?? [])].sort()).toEqual([...FRAME_SRC].sort());
    expect(config.app.security.csp.match(/frame-src/g)).toHaveLength(1);
  });

  it("allows no other origin in any directive, and widens neither script-src nor default-src", () => {
    expect([...csp.keys()].sort()).toEqual(Object.keys(ALLOWED).sort());
    for (const [name, sources] of csp) expect([...sources].sort(), name).toEqual([...ALLOWED[name]].sort());
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("default-src")).toEqual(["'self'"]);
  });

  it("keeps the frame sources in step with the URL gate's hosts", () => {
    expect([...FRAME_SRC].map((s) => new URL(s.replace(":*", "")).hostname).sort()).toEqual([...LOOPBACK_HOSTS].sort());
    for (const s of FRAME_SRC) expect(s).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\*$/);
  });
});

describe("no Tauri IPC for the frame's origin", () => {
  it("has capabilities for the main window only, with no remote URL entry", () => {
    const files = Object.entries(capabilities);
    expect(files.length).toBeGreaterThan(0);
    for (const [file, text] of files) {
      const cap = JSON.parse(text) as { windows?: string[]; webviews?: string[]; remote?: unknown; permissions?: unknown[] };
      expect(cap.remote, `${file} must not grant a remote origin`).toBeUndefined();
      expect(cap.windows, file).toEqual(["main"]);
      expect(cap.webviews, file).toBeUndefined();
      expect(JSON.stringify(cap.permissions), file).not.toMatch(/webview|window:allow-create|allow-eval|shell|fs:|http:|opener/i);
    }
  });

  it("does not expose the global Tauri object or the remote IPC escape hatch", () => {
    expect(config.app.withGlobalTauri).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/dangerousRemoteDomainIpcAccess|dangerousDisableAssetCspModification|remote/);
  });
});

describe("the frame sandbox", () => {
  it("lets the page run but never navigates the IDE, downloads or escapes the sandbox", () => {
    const tokens = FRAME_SANDBOX.split(" ");
    expect(tokens).toEqual(expect.arrayContaining(["allow-scripts", "allow-same-origin", "allow-forms"]));
    for (const forbidden of ["allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-popups-to-escape-sandbox", "allow-downloads", "allow-presentation", "allow-pointer-lock", "allow-orientation-lock"]) {
      expect(tokens).not.toContain(forbidden);
    }
  });
});
