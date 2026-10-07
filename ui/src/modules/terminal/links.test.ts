import { describe, expect, it } from "vitest";
import { findFileRefs, resolveInRepo } from "./links";

describe("findFileRefs", () => {
  it("finds path:line and path:line:col with their offsets", () => {
    const line = "src/app/main.ts:12:5 - error TS2322";
    expect(findFileRefs(line)).toEqual([{ start: 0, end: 20, path: "src/app/main.ts", line: 12, column: 5 }]);
  });

  it("finds paths inside parentheses and after 'at', and several per line", () => {
    const refs = findFileRefs("    at render (./ui/View.tsx:88:3) from /abs/x.py:9");
    expect(refs.map((r) => [r.path, r.line, r.column])).toEqual([["./ui/View.tsx", 88, 3], ["/abs/x.py", 9, undefined]]);
  });

  it("takes a bare file name only with a known source extension", () => {
    expect(findFileRefs("package.json:3 and lib.rs:7")).toHaveLength(2);
    expect(findFileRefs("example.com:8080 and server.local:22")).toEqual([]);
  });

  it("ignores URLs and plain numbers", () => {
    expect(findFileRefs("see https://host.dev/a/b.ts:80 at 12:30:45")).toEqual([]);
  });
});

describe("resolveInRepo", () => {
  const repos = [{ id: "api", path: "/w/api" }, { id: "api-docs", path: "/w/api/docs" }];

  it("resolves relative paths against the terminal's directory", () => {
    expect(resolveInRepo("src/a.ts", "/w/api", repos)).toEqual({ repoId: "api", path: "src/a.ts" });
    expect(resolveInRepo("../src/a.ts", "/w/api/sub", repos)).toEqual({ repoId: "api", path: "src/a.ts" });
  });

  it("prefers the innermost repo for absolute paths", () => {
    expect(resolveInRepo("/w/api/docs/readme.md", "/", repos)).toEqual({ repoId: "api-docs", path: "readme.md" });
  });

  it("refuses paths outside every repo", () => {
    expect(resolveInRepo("/etc/hosts.conf", "/w/api", repos)).toBeUndefined();
    expect(resolveInRepo("../../x.ts", "/w/api", repos)).toBeUndefined();
    expect(resolveInRepo("/w/api", "/w/api", repos)).toBeUndefined();
  });
});
