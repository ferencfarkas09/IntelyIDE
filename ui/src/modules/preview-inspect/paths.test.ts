import { describe, expect, it } from "vitest";
import { resolveHintPath, type RepoRoot } from "./paths";

const repos: RepoRoot[] = [
  { id: "admin", path: "/Users/x/Projects/admin" },
  { id: "pos", path: "/Users/x/Projects/shop-pos/" },
  { id: "inner", path: "/Users/x/Projects/admin/packages/inner" },
];

describe("resolveHintPath: a claimed file must land inside a registered repo", () => {
  it("maps absolute paths to repo-relative ones", () => {
    expect(resolveHintPath("/Users/x/Projects/admin/src/pages/Login.js", repos)).toEqual({ repoId: "admin", path: "src/pages/Login.js", thirdParty: false });
    expect(resolveHintPath("/Users/x/Projects/shop-pos/src/a.js", repos)?.repoId).toBe("pos");
  });

  it("the longest registered root wins for nested repos", () => {
    expect(resolveHintPath("/Users/x/Projects/admin/packages/inner/src/a.js", repos)).toMatchObject({ repoId: "inner", path: "src/a.js" });
  });

  it("resolves relative paths against the preview tab's repo only", () => {
    expect(resolveHintPath("src/App.jsx", repos, "admin")).toEqual({ repoId: "admin", path: "src/App.jsx", thirdParty: false });
    expect(resolveHintPath("./src//App.jsx", repos, "admin")?.path).toBe("src/App.jsx");
    expect(resolveHintPath("src/App.jsx", repos)).toBeUndefined();
    expect(resolveHintPath("src/App.jsx", repos, "nope")).toBeUndefined();
  });

  it("refuses everything outside the repos", () => {
    for (const f of ["/etc/passwd", "/Users/x/.ssh/id_rsa", "/Users/x/Projects/other/src/a.js", "/Users/x/Projects/admin-evil/src/a.js", "/Users/x/Projects/admin", "/Users/x/Projects/admin/", "/"]) {
      expect(resolveHintPath(f, repos, "admin"), f).toBeUndefined();
    }
  });

  it("never fixes up traversal", () => {
    for (const f of ["../secret", "src/../../etc/passwd", "/Users/x/Projects/admin/../.ssh/id_rsa", "/Users/x/Projects/admin/src/../../../../etc/hosts", ".."]) {
      expect(resolveHintPath(f, repos, "admin"), f).toBeUndefined();
    }
  });

  it("refuses control characters, backslashes and empty paths", () => {
    for (const f of ["", "a\0.js", "a\n.js", "C:\\x\\y.js", "/Users/x/Projects/admin/a\u202e.js"]) expect(resolveHintPath(f, repos, "admin"), JSON.stringify(f)).toBeUndefined();
  });

  it("normalises to NFC before comparing", () => {
    const decomposed = "/Users/x/Projects/admin/src/e\u0301.js"; // e + combining acute
    expect(resolveHintPath(decomposed, repos)?.path).toBe("src/\u00e9.js");
    const accented: RepoRoot[] = [{ id: "a", path: "/Users/x/Prójekt".normalize("NFD") }];
    expect(resolveHintPath("/Users/x/Prójekt/src/a.js", accented)?.path).toBe("src/a.js");
  });

  it("flags library code but still resolves it", () => {
    expect(resolveHintPath("/Users/x/Projects/admin/node_modules/@mui/material/Button/Button.js", repos)).toMatchObject({ repoId: "admin", thirdParty: true });
    expect(resolveHintPath("node_modules/.pnpm/x@1/node_modules/x/i.js", repos, "admin")?.thirdParty).toBe(true);
  });
});
