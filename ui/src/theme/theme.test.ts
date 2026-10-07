import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createThemeController, parsePreference, resolveTheme, THEME_STORAGE_KEY, type ThemeEnv } from "./theme";

function fakeEnv(opts: { stored?: string; systemDark?: boolean; storageThrows?: boolean } = {}) {
  const attrs: Record<string, string> = {};
  const store: Record<string, string> = opts.stored ? { [THEME_STORAGE_KEY]: opts.stored } : {};
  let listener: ((e: { matches: boolean }) => void) | undefined;
  const env: ThemeEnv = {
    storage: {
      getItem: (k) => { if (opts.storageThrows) throw new Error("blocked"); return store[k] ?? null; },
      setItem: (k, v) => { if (opts.storageThrows) throw new Error("blocked"); store[k] = v; },
      removeItem: (k) => void delete store[k],
    },
    root: { setAttribute: (n, v) => void (attrs[n] = v) },
    media: {
      matches: opts.systemDark ?? true,
      addEventListener: (_t, cb) => void (listener = cb),
      removeEventListener: () => void (listener = undefined),
    },
  };
  return { env, attrs, store, fire: (matches: boolean) => listener?.({ matches }), hasListener: () => !!listener };
}

const make = (env: ThemeEnv) => createRoot((d) => Object.assign(createThemeController(env), { d }));

describe("theme helpers", () => {
  it("parses unknown input to system", () => {
    expect(parsePreference("dark")).toBe("dark");
    expect(parsePreference("light")).toBe("light");
    expect(parsePreference("system")).toBe("system");
    expect(parsePreference("purple")).toBe("system");
    expect(parsePreference(null)).toBe("system");
  });

  it("resolves system by the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("theme controller", () => {
  it("applies the stored preference on creation", () => {
    const f = fakeEnv({ stored: "light", systemDark: true });
    const c = make(f.env);
    expect(c.preference()).toBe("light");
    expect(f.attrs["data-theme"]).toBe("light");
    expect(f.attrs["data-theme-pref"]).toBe("light");
  });

  it("follows the OS in system mode, including live changes", () => {
    const f = fakeEnv({ systemDark: false });
    const c = make(f.env);
    expect(c.resolved()).toBe("light");
    f.fire(true);
    expect(c.resolved()).toBe("dark");
    expect(f.attrs["data-theme"]).toBe("dark");
    expect(f.attrs["data-theme-pref"]).toBe("system");
  });

  it("ignores OS changes once the user overrides", () => {
    const f = fakeEnv({ systemDark: true });
    const c = make(f.env);
    c.setPreference("light");
    f.fire(true);
    expect(c.resolved()).toBe("light");
    expect(f.attrs["data-theme"]).toBe("light");
  });

  it("persists the choice and cycles system -> dark -> light", () => {
    const f = fakeEnv();
    const c = make(f.env);
    c.cycle();
    expect(c.preference()).toBe("dark");
    expect(f.store[THEME_STORAGE_KEY]).toBe("dark");
    c.cycle();
    expect(c.preference()).toBe("light");
    c.cycle();
    expect(c.preference()).toBe("system");
  });

  it("works when storage throws", () => {
    const f = fakeEnv({ storageThrows: true });
    const c = make(f.env);
    expect(c.preference()).toBe("system");
    expect(() => c.setPreference("light")).not.toThrow();
    expect(c.resolved()).toBe("light");
  });

  it("stops listening on dispose", () => {
    const f = fakeEnv();
    const c = make(f.env);
    expect(f.hasListener()).toBe(true);
    c.dispose();
    expect(f.hasListener()).toBe(false);
  });

  it("defaults to dark without a media query", () => {
    const f = fakeEnv();
    const c = make({ ...f.env, media: null });
    expect(c.resolved()).toBe("dark");
  });
});
