import { describe, expect, it, vi } from "vitest";
import type { SearchBatch, SearchHit, SearchIpc } from "../../ipc/search";
import { definitionPattern, findDefinitions, rankCandidates } from "./nameLookup";

const hit = (path: string, line: number, preview: string, repoId = "admin"): SearchHit => ({ repoId, path, line, col: 1, preview });

function fakeSearch(batches: (id: string) => SearchBatch[], opts: { early?: boolean } = {}) {
  const listeners = new Set<(b: SearchBatch) => void>();
  const start = vi.fn(async (_q: string, _o?: unknown) => {
    const id = "s1";
    const send = () => batches(id).forEach((b) => listeners.forEach((l) => l(b)));
    if (opts.early) send();
    else setTimeout(send, 0);
    return { searchId: id };
  });
  const cancel = vi.fn(async () => {});
  const search: SearchIpc = { start, cancel, onResults: (cb) => (listeners.add(cb), () => void listeners.delete(cb)) };
  return { search, start, cancel };
}

describe("definitionPattern", () => {
  it("matches definitions with ERE-compatible syntax (no \\s, no \\b)", () => {
    const re = new RegExp(definitionPattern("LoginForm"));
    for (const line of ["function LoginForm(props) {", "export default function LoginForm() {", "const LoginForm = () => {", "export const LoginForm = memo(", "class LoginForm extends React.Component {", "  let LoginForm;"]) expect(re.test(line), line).toBe(true);
    for (const line of ["function LoginFormX() {", "const MyLoginForm = 1", "<LoginForm />", "import LoginForm from './x'", "const a = LoginForm", "obj.function LoginForm"]) expect(re.test(line), line).toBe(false);
    expect(definitionPattern("a$b")).toContain("a\\$b");
    expect(definitionPattern("LoginForm")).not.toMatch(/\\[sbd]/);
  });
});

describe("rankCandidates", () => {
  it("prefers the file named after the component, exports and src, and drops tests and library code", () => {
    const out = rankCandidates("Login", [
      hit("src/pages/auth/Login.test.js", 3, "function Login() {}"),
      hit("node_modules/x/Login.js", 1, "function Login() {}"),
      hit("src/legacy/old.js", 9, "function Login() {"),
      hit("src/pages/auth/Login.js", 12, "export default function Login() {"),
      hit("src/pages/auth/Login.js", 12, "export default function Login() {"),
      hit("docs/readme.md", 1, "function Login"),
    ]);
    expect(out.map((c) => `${c.path}:${c.line}`)).toEqual(["src/pages/auth/Login.js:12", "src/legacy/old.js:9", "src/pages/auth/Login.test.js:3"]);
  });
  it("treats Name/index.js as named after the component and caps the list", () => {
    expect(rankCandidates("Nav", [hit("src/a.js", 1, "function Nav"), hit("src/Nav/index.js", 1, "function Nav")])[0]!.path).toBe("src/Nav/index.js");
    const many = Array.from({ length: 40 }, (_, i) => hit(`src/f${i}.js`, 1, "function Nav"));
    expect(rankCandidates("Nav", many)).toHaveLength(12);
  });
});

describe("findDefinitions", () => {
  it("searches the repo with the definition regex and returns ranked candidates", async () => {
    const f = fakeSearch((id) => [{ searchId: id, hits: [hit("src/Login.js", 4, "function Login() {")], done: true }]);
    const out = await findDefinitions(f.search, "Login", ["admin"]);
    expect(out).toEqual([{ repoId: "admin", path: "src/Login.js", line: 4, col: 1, preview: "function Login() {" }]);
    const [q, opts] = f.start.mock.calls[0]!;
    expect(q).toBe(definitionPattern("Login"));
    expect(opts).toMatchObject({ regex: true, caseSensitive: true, repoIds: ["admin"] });
    expect(f.cancel).toHaveBeenCalled();
  });

  it("handles batches that arrive before start() resolves", async () => {
    const f = fakeSearch((id) => [{ searchId: id, hits: [hit("src/Login.js", 4, "function Login() {")], done: true }], { early: true });
    expect(await findDefinitions(f.search, "Login")).toHaveLength(1);
  });

  it("ignores batches of other searches", async () => {
    const f = fakeSearch((id) => [{ searchId: "other", hits: [hit("src/Other.js", 1, "function Login() {")], done: true }, { searchId: id, hits: [], done: true }]);
    expect(await findDefinitions(f.search, "Login")).toEqual([]);
  });

  it("refuses names that are not plain identifiers, without searching", async () => {
    const f = fakeSearch(() => []);
    for (const n of ["", "a b", "a.b", "memo(Foo)", "x|y", ".*", "A;rm -rf"]) expect(await findDefinitions(f.search, n), n).toEqual([]);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("a failing search is an empty list, not an error", async () => {
    const search: SearchIpc = { start: async () => { throw new Error("no git"); }, cancel: async () => {}, onResults: () => () => {} };
    expect(await findDefinitions(search, "Login")).toEqual([]);
  });
});
