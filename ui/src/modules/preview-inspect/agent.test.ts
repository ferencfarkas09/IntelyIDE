// The page-side inspector (crates/preview-proxy/assets/inspector.js) is plain JS that the proxy injects. Its mapping
// logic is exported for node, so it is tested here against hand-made fibers and stacks. The browser behaviour
// (Alt/Cmd+click, postMessage) is covered end to end by scripts/preview/e2e-inspect.mjs.
import { afterEach, describe, expect, it, vi } from "vitest";
import src from "../../../../crates/preview-proxy/assets/inspector.js?raw";

interface Agent {
  normalizeFile(f: unknown): string;
  isThirdParty(f: string): boolean;
  parseDataLoc(v: unknown): { file: string; line: number; col: number } | null;
  parseStack(s: string): { fn: string; url: string; line: number; col: number }[];
  callerFrame(s: string): { fn: string; url: string; line: number; col: number } | null;
  nearestComponentName(f: unknown): string;
  decodeMappings(m: string): number[][][];
  originalPosition(map: unknown, line: number, col: number): { source: string; line: number; col: number } | null;
  resolveElement(el: Element): Promise<{ file: string; line: number; col: number; componentName: string } | null>;
}

const mod: { exports: Agent } = { exports: {} as Agent };
new Function("module", "exports", src).call({}, mod, mod.exports);
const agent = mod.exports;

const FIBER = "__reactFiber$test";
function el(fiber: unknown, attrs: Record<string, string> = {}, parent?: Element): HTMLElement {
  const e = document.createElement("div");
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  if (fiber) (e as unknown as Record<string, unknown>)[FIBER] = fiber;
  parent?.appendChild(e);
  return e;
}
const comp = (name: string, owner: object | null, source?: object) => ({ type: Object.assign(function () {}, { displayName: name }), _debugOwner: owner, _debugSource: source });
const ds = (fileName: string, lineNumber: number, columnNumber = 5) => ({ fileName, lineNumber, columnNumber });

afterEach(() => vi.unstubAllGlobals());

describe("normalizeFile", () => {
  it("understands the spellings bundlers produce", () => {
    const n = agent.normalizeFile;
    expect(n("/Users/x/admin/src/App.js")).toBe("/Users/x/admin/src/App.js");
    expect(n("webpack-internal:///./src/App.js")).toBe("src/App.js");
    expect(n("webpack-internal:///(app-pages-browser)/./src/App.js")).toBe("src/App.js");
    expect(n("webpack://admin/./src/App.js")).toBe("src/App.js");
    expect(n("file:///Users/x/admin/src/A%20b.js")).toBe("/Users/x/admin/src/A b.js");
    expect(n("/@fs/Users/x/admin/src/App.jsx?t=123")).toBe("/Users/x/admin/src/App.jsx");
    expect(n("./src//x/./y.js#frag")).toBe("src//x/y.js");
    expect(n("../src/App.jsx")).toBe("src/App.jsx"); // esbuild/vite source maps are relative to the output folder
    expect(n("../../../../etc/passwd")).toBe("etc/passwd"); // never a traversal: at worst a path under the preview's repo
  });
  it("refuses what is not a source file", () => {
    for (const bad of ["http://127.0.0.1:5000/static/js/main.js", "https://cdn.example/x.js", "", null, undefined, 5, "/"]) expect(agent.normalizeFile(bad), String(bad)).toBe("");
  });
  it("flags library code", () => {
    expect(agent.isThirdParty("/r/node_modules/@mui/Button.js")).toBe(true);
    expect(agent.isThirdParty("/r/src/node_modules_like/a.js")).toBe(false);
  });
});

describe("data-loc and stacks", () => {
  it("parses data-loc from the right", () => {
    expect(agent.parseDataLoc("src/pages/Login.js:34:7")).toEqual({ file: "src/pages/Login.js", line: 34, col: 7 });
    expect(agent.parseDataLoc("src/a.js:9")).toEqual({ file: "src/a.js", line: 9, col: 1 });
    for (const bad of ["", "nonsense", "src/a.js:0:1", "http://x/y.js:1:1", null]) expect(agent.parseDataLoc(bad), String(bad)).toBeNull();
  });
  it("parses V8 and JavaScriptCore stacks", () => {
    const v8 = "Error: react-stack-top-frame\n    at exports.jsxDEV (http://h/react-jsx-dev-runtime.development.js:5:9)\n    at LoginForm (http://h/bundle.js:120:15)\n    at http://h/bundle.js:9:1";
    expect(agent.parseStack(v8)).toEqual([
      { fn: "exports.jsxDEV", url: "http://h/react-jsx-dev-runtime.development.js", line: 5, col: 9 },
      { fn: "LoginForm", url: "http://h/bundle.js", line: 120, col: 15 },
      { fn: "", url: "http://h/bundle.js", line: 9, col: 1 },
    ]);
    expect(agent.parseStack("LoginForm@http://h/bundle.js:120:15\nglobal code@http://h/bundle.js:1:1")).toHaveLength(2);
    expect(agent.parseStack(undefined as unknown as string)).toEqual([]);
  });
  it("skips React's own frames to find the caller", () => {
    const stack = "Error: react-stack-top-frame\n    at exports.jsxDEV (http://h/node_modules/react/cjs/react-jsx-dev-runtime.development.js:5:9)\n    at Object.react_stack_bottom_frame (http://h/react-dom-client.development.js:1:1)\n    at LoginForm (webpack-internal:///./src/Login.js:34:7)";
    expect(agent.callerFrame(stack)).toMatchObject({ fn: "LoginForm", line: 34, col: 7 });
  });
});

describe("source maps", () => {
  const vlq = (n: number) => {
    const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let v = n < 0 ? (-n << 1) | 1 : n << 1;
    let out = "";
    do {
      let d = v & 31;
      v >>>= 5;
      if (v) d |= 32;
      out += B[d];
    } while (v);
    return out;
  };
  const seg = (...f: number[]) => f.map(vlq).join("");

  it("decodes mappings and looks up original positions", () => {
    // generated line 1: col 0 -> a.js 0:0, col 10 -> a.js 4:2 ; line 2: col 3 -> b.js 7:1
    const mappings = [seg(0, 0, 0, 0), seg(10, 0, 4, 2)].join(",") + ";" + seg(3, 1, 3, -1);
    const map = { version: 3, sources: ["webpack://app/./src/a.js", "src/b.js"], mappings };
    expect(agent.originalPosition(map, 1, 1)).toEqual({ source: "webpack://app/./src/a.js", line: 1, col: 1 });
    expect(agent.originalPosition(map, 1, 12)).toEqual({ source: "webpack://app/./src/a.js", line: 5, col: 3 });
    expect(agent.originalPosition(map, 2, 4)).toEqual({ source: "src/b.js", line: 8, col: 2 });
    expect(agent.originalPosition(map, 2, 1)).toBeNull();
    expect(agent.originalPosition(map, 9, 1)).toBeNull();
    expect(agent.originalPosition({ mappings: 5, sources: [] }, 1, 1)).toBeNull();
  });
});

describe("resolveElement", () => {
  it("React <= 18 with a jsx-source plugin: the element's own _debugSource, with the owner's name", async () => {
    const app = comp("LoginForm", null, ds("/r/admin/src/Login.js", 80));
    const host = { type: "button", _debugOwner: app, _debugSource: ds("/r/admin/src/Login.js", 34, 9) };
    expect(await agent.resolveElement(el(host))).toEqual({ file: "/r/admin/src/Login.js", line: 34, col: 9, componentName: "LoginForm" });
  });

  it("an element rendered inside library code maps to the user's call site up the owner chain", async () => {
    const page = comp("Settings", null, ds("/r/admin/src/Settings.js", 12));
    const mui = comp("Button", page, ds("/r/admin/src/Settings.js", 55, 7)); // <Button> used at Settings.js:55
    const host = { type: "span", _debugOwner: mui, _debugSource: ds("/r/admin/node_modules/@mui/material/Button/Button.js", 300) };
    expect(await agent.resolveElement(el(host))).toMatchObject({ file: "/r/admin/src/Settings.js", line: 55, col: 7, componentName: "Button" });
  });

  it("all-library chains still return the first source rather than nothing", async () => {
    const host = { type: "span", _debugOwner: null, _debugSource: ds("/r/admin/node_modules/lib/a.js", 3) };
    expect(await agent.resolveElement(el(host))).toMatchObject({ file: "/r/admin/node_modules/lib/a.js", line: 3 });
  });

  it("walks up the DOM to the first element that maps", async () => {
    const outer = el({ type: "section", _debugSource: ds("/r/admin/src/Page.js", 10) });
    const inner = el(null, {}, outer);
    expect(await agent.resolveElement(inner)).toMatchObject({ file: "/r/admin/src/Page.js", line: 10 });
  });

  it("data-loc beats a bare name but loses to a real source", async () => {
    const owner = comp("Row", null);
    const withLoc = el({ type: "li", _debugOwner: owner }, { "data-loc": "src/Row.js:7:3" });
    expect(await agent.resolveElement(withLoc)).toEqual({ file: "src/Row.js", line: 7, col: 3, componentName: "Row" });
    const both = el({ type: "li", _debugOwner: owner, _debugSource: ds("/r/admin/src/Row.js", 20) }, { "data-loc": "src/Other.js:1:1" });
    expect((await agent.resolveElement(both))!.line).toBe(20);
  });

  it("no source anywhere: a component name only, from the owner chain then the parents", async () => {
    const byOwner = el({ type: "div", _debugOwner: comp("Banner", null) });
    expect(await agent.resolveElement(byOwner)).toEqual({ file: "", line: 0, col: 0, componentName: "Banner" });
    const parentFiber = comp("Shell", null);
    const byReturn = el({ type: "div", return: parentFiber, _debugOwner: null });
    expect((await agent.resolveElement(byReturn))!.componentName).toBe("Shell");
    expect(await agent.resolveElement(el(null))).toBeNull();
  });

  it("memo and forwardRef wrappers give their inner name", () => {
    const inner = function Card() {};
    expect(agent.nearestComponentName({ type: { $$typeof: 1, type: inner } })).toBe("Card");
    expect(agent.nearestComponentName({ type: { $$typeof: 2, render: function Field() {} } })).toBe("Field");
  });

  it("React 19: _debugStack with a webpack-internal frame needs no source map", async () => {
    const stack = "Error: react-stack-top-frame\n    at exports.jsxDEV (react-jsx-dev-runtime.development.js:5:9)\n    at LoginForm (webpack-internal:///(app-pages-browser)/./src/Login.js:34:7)";
    const host = { type: "button", _debugOwner: comp("LoginForm", null), _debugStack: new Error("x") };
    Object.defineProperty(host._debugStack, "stack", { value: stack });
    expect(await agent.resolveElement(el(host))).toEqual({ file: "src/Login.js", line: 34, col: 7, componentName: "LoginForm" });
  });

  it("React 19: a bundle frame is mapped through the bundle's source map", async () => {
    const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const enc = (n: number) => B[n << 1]; // small positive values only
    const map = { version: 3, sources: ["/r/app/src/App.jsx"], mappings: `;;${enc(4)}A${enc(8)}${enc(3)}` }; // line 3, gen col 4 -> App.jsx 8:3
    const bundle = "console.log(1)\n//# sourceMappingURL=bundle.js.map\n";
    const fetchMock = vi.fn(async (url: string) => (url.endsWith(".map") ? { json: async () => map } : { text: async () => bundle }));
    vi.stubGlobal("fetch", fetchMock);
    const host = { type: "p", _debugOwner: comp("App", null), _debugStack: { stack: "Error\n    at jsxDEV (http://127.0.0.1:5000/node_modules/react/jsx-dev-runtime.js:1:1)\n    at App (http://127.0.0.1:5000/bundle.js:3:8)" } };
    expect(await agent.resolveElement(el(host))).toEqual({ file: "/r/app/src/App.jsx", line: 9, col: 4, componentName: "App" });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["http://127.0.0.1:5000/bundle.js", "http://127.0.0.1:5000/bundle.js.map"]);
  });

  it("a bundle without a map falls back to the name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => "no map here" })));
    const host = { type: "p", _debugOwner: comp("App", null), _debugStack: { stack: "Error\n    at App (http://127.0.0.1:5001/bundle.js:3:8)" } };
    expect(await agent.resolveElement(el(host))).toEqual({ file: "", line: 0, col: 0, componentName: "App" });
  });
});
