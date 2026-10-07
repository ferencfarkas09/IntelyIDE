# Demo workspace generator

Builds the fictional "Fernbank Cycles" workspace used for the README screenshots: four repositories with believable
history, bare remotes and a workspace file. Everything is generated, deterministic and below the temp directory.
Spec: `docs/release-ci-spec.md` section 6 (tasks RC10 to RC13 and RC17).

```
scripts/demo-workspace/make-demo-workspace.sh [--dir <new dir under the temp dir>] [--registry]
                                              [--tar <file>] [--restore <file>] [--print-plan]
                                              [--module <file>]... [--allow-missing]
node scripts/demo-workspace/check-demo.mjs --root <dir> [--only fb-api,fb-web] [--module <file>]...
                                           [--require-local-needles] [--fingerprint]
scripts/demo-workspace/verify-determinism.sh [--module <file>]...        # gate G13
```

The last stdout line of `make-demo-workspace.sh` is the root:

```
<root>/remotes/<id>.git    bare remotes (file transport)
<root>/repos/<id>          the work trees
<root>/extra/<id>          two near-empty repos for the welcome screen (docs-site, side-project)
<root>/workspace.json      pinned mode:    INTELY_WORKSPACE=<root>/workspace.json
<root>/workspaces.json     with --registry: INTELY_WORKSPACES=<root>/workspaces.json (+ workspaces/<id>.json)
```

Run the app against it only with `INTELY_E2E=1 INTELY_FIXTURE_ROOT=<root>` (the jail, `docs/safety.md`).

## Safety

- Refuses a root outside the temp dir (symlinks are resolved first) and a non-empty root; without `--dir` it makes a
  fresh directory under the temp dir after everything else was validated. A failed run removes what it created.
- The git environment is built from scratch (`lib/git.mjs`): `TZ=UTC LC_ALL=C`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_SYSTEM=/dev/null`, no hooks while generating, no prompt. Nothing is inherited: no `GIT_*`, `INTELY_*`,
  `APPLE_*`, token or `HOME` variable reaches git.
- No network, no GitHub, no credential, no real model. The user's repositories are never read.
- Every file name, file content, commit message, author, tag and branch name passes the `publish-scan` `RULES` plus
  generic rules (`lib/rules.mjs`): no home or temp path, no e-mail outside `*.example` / `*.invalid`, no URL host
  other than `example.com` / `*.example`. A module that fails is refused before anything is written; `check-demo.mjs`
  repeats the scan on the generated repositories. Owner-specific needles are never stored here: they are read at run
  time from `scripts/licenses/publish-scan.local.json` (untracked); `--require-local-needles` fails without that file.

## Determinism

Same modules give the same commit hashes, tree, status and tags. Per commit `GIT_AUTHOR_*` and `GIT_COMMITTER_*` come
from the step (`<epoch> +0000`), every other git call carries the frozen identity `release-bot` at the tour's "now"
(2026-09-28T16:00:00Z), merges use `--no-ff`, tags are annotated, no `gc`, no repack. `lib/fingerprint.mjs` hashes
refs, `git status --porcelain=v2` and the file tree per repository; `verify-determinism.sh` generates twice and
compares them (plus `check-demo.mjs`).

`--tar <file>` stores `repos/`, `remotes/` and `extra/` as a deterministic ustar (sorted, fixed mtime, uid/gid 0; the
root path inside `config` and `FETCH_HEAD` is replaced by a placeholder; git index stat data is zeroed). `--restore
<file> --dir <new dir>` unpacks it, points the `insteadOf` rewrite at the new root and rewrites the workspace files.
Restoring a tiny repository takes a few tens of milliseconds; the four real repositories have not been measured here.
The cache lives under `.scratch/`, never in git.

## Writing a repository data module

A module is an `.mjs` file whose default export describes one repository. File contents are template strings inside
the module so that TypeScript, lint and CodeQL tooling do not treat them as project source. `lib/schema.mjs`
validates every module before anything is written (`node -e` of `validateModule` lists all problems).

```js
export default {
  id: "fb-api",                // ^[a-z][a-z0-9-]{0,30}$; also the directory and remote name
  name: "fb-api",
  branch: "feature/order-refunds",   // the branch that is checked out at the end; must receive a commit in history
  files: { "src/app.ts": "...", "scripts/run.sh": { text: "...", exec: true } },   // the committed HEAD content
  history: [                   // ordered; dates never go backwards
    { at: "2026-08-24T09:00:00Z",          // inside the anchor window of data/brand.json (2026-08-24 .. 2026-09-26)
      author: "mira",                      // a key of brand.json "authors"
      message: "chore: initial commit",    // subject <= 100 chars, optional body after a blank line
      branch: "main",                      // optional; the first step commits on main; a new name is created from HEAD
      changes: { "src/app.ts": "text", "old.ts": null, "new.ts": { renameFrom: "old.ts", text: "optional edit" } },
      tag: "v1.0.0" },                     // optional annotated tag; { name, message } also works
    { at: "...", author: "tomas", message: "Merge branch 'fix/x'", branch: "main",
      merge: { from: "fix/x", message: "Merge branch 'fix/x'" } },   // --no-ff, conflict-free by construction, no changes
  ],
  worktree: {                  // the uncommitted state
    modify: { path: "new text" },          // unstaged edits
    stageAdd: { path: "text" },            // new file, staged
    delete: ["path"],                      // unstaged delete
    stageRename: [{ from: "a", to: "b", text: "optional" }],
    stage: ["path"],                       // must be in modify: staged in full ...
    thenModify: { path: "later text" },    // ... then edited again: the partially staged state
    untracked: { ".env": "KEY=change-me\n", "dump_2026-09-30/a.json": "{}\n" },
    hunkTargets: [{ path: "src/orders/totals.ts", hunks: 3 }],   // check-demo asserts the hunk count against HEAD
  },
  agentEdit: { path: "src/orders/totals.ts", before: "...", after: "..." },   // reused by the mock scenario (RC13)

  // optional
  upstream: { ahead: 3, behind: 0 },       // distance of the checked-out branch from origin/<branch>
  upstreamExtra: [ /* steps without branch/tag/merge */ ],   // exactly `behind` commits that exist on the remote only
  remoteOnlyBranches: [{ name: "release/1.9", from: "v1.9.0" }],   // pushed, never created locally
  hooks: { "pre-commit": "#!/bin/sh\necho 'pre-commit: lint ok'\n" },   // default is exactly this pre-commit hook
  expect: { /* an outcomes row for check-demo, see lib/outcomes.mjs; the four real repos use OUTCOMES there */ },
};
```

Rules the validator enforces: relative normalised paths (no `/x`, `..`, `.git` segment, backslash, NUL), well-formed
UTF-8 text without NUL or U+FFFD (binary content is not supported), dates inside the anchor window and not going
backwards, known authors, no unknown keys, merge sources that already have a commit, unique tags, `upstream.behind`
equal to the length of `upstreamExtra`. After the history is built the generator also proves that `files` equals the
committed HEAD tree exactly (content and executable bit), so the two cannot drift apart.

To add a repository: write `data/<id>.mjs`, add `{ id, name, color, badge }` to `data/brand.json` `repos`, add the id to
`DEFAULT_IDS` in `lib/modules.mjs` and a row to `OUTCOMES` in `lib/outcomes.mjs` (or put `expect` in the module), then run
`check-demo.mjs`. Tests for a module use `--module <file>`; `test/fixtures/fb-tiny.mjs` is the smallest complete example.

`data/brand.json` holds the company name, domain (`fernbank.example`), the git host shown for `origin`, authors, repo
colours and badges, the anchor window and the extra welcome-screen workspaces; a rename is a data change.

## Tests

```
node --test "scripts/demo-workspace/test/**/*.test.mjs"
```

`test/core.test.mjs` generates the fixture repository (about 10 s per generation on a loaded laptop) and covers
refusals, determinism, tar round trip, environment scrub and content rules; `test/schema.test.mjs` is pure. The
data-module tests of RC11/RC12 and the scenario test of RC13 live in the same directory.
