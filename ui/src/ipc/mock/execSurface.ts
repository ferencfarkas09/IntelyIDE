// Mock stand-in for the Rust command `exec_surface_check` (crates/agent_core/src/policy/paths.rs holds the real list).
// A compact approximation for the browser mock and the tests only; the app never uses it.
const NAMES = /^(package\.json|\.lintstagedrc.*|lint-staged\.config\..*|lefthook.*\.ya?ml|\.pre-commit-config\.yaml|\.simple-git-hooks.*|simple-git-hooks\.js|commitlint\.config\..*|\.commitlintrc\.js|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|g?makefile|justfile|taskfile\.ya?ml|\.gitlab-ci\.yml|build\.rs|\.babelrc|\.mocharc\.c?js|gulpfile\.js|conftest\.py|setup\.py|(\.eslintrc|eslint\.config|jest\.config|vitest\.config|vitest\.workspace|vite\.config|babel\.config|\.babelrc|prettier\.config|\.prettierrc|rollup\.config|playwright\.config|tsup\.config)\..*|webpack\.config.*)$/i;
const DIRS = /(^|\/)(\.husky\/|\.githooks\/|\.github\/workflows\/|\.vscode\/(tasks|settings)\.json$|\.idea\/workspace\.xml$|\.cargo\/config(\.toml)?$)/i;

export function mockRunsCode(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return !base.endsWith(".md") && (NAMES.test(base) || DIRS.test(path));
}
