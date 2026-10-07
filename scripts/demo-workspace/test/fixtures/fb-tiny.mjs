// Tiny valid repo module used by the RC10 tests (the real data modules arrive with RC11/RC12). It exercises every
// feature of the schema: branches, a merge, an annotated tag, a rename, a delete, ahead/behind, a remote-only branch
// and every kind of uncommitted state, including a file with exactly three hunks.
const line = (n, tag) => `export const line${n} = ${JSON.stringify(tag ?? "base")};`;
const greet = (a, b, c) =>
  Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    if (n === 3) return line(n, a);
    if (n === 15) return line(n, b);
    if (n === 27) return line(n, c);
    return line(n);
  }).join("\n") + "\n";

const readme1 = "# fb-tiny\n\nTiny demo repo.\n";
const readme2 = "# fb-tiny\n\nTiny demo repository.\n";
const app1 = 'export const app = "one";\n';
const app2 = 'export const app = "two";\n';
const app3 = 'export const app = "three";\n';
const util = "export const util = 1;\n";
const old = "export const old = true;\n";
const feature1 = "export const feature = 1;\n";
const feature2 = "export const feature = 2;\n";

export default {
  id: "fb-tiny",
  name: "fb-tiny",
  branch: "feature/tiny",
  files: {
    "README.md": readme2,
    "src/app.ts": app3,
    "src/greet.ts": greet(),
    "src/helpers.ts": util,
    "src/feature.ts": feature2,
    "scripts/run.sh": { text: "#!/bin/sh\necho tiny\n", exec: true },
  },
  history: [
    { at: "2026-08-24T09:00:00Z", author: "mira", message: "chore: initial commit", branch: "main", changes: { "README.md": readme1, "src/app.ts": app1, "src/greet.ts": greet(), "src/util.ts": util, "src/old.ts": old, "scripts/run.sh": { text: "#!/bin/sh\necho tiny\n", exec: true } } },
    { at: "2026-08-25T10:30:00Z", author: "daniel", message: "feat: second app version", changes: { "src/app.ts": app2 }, tag: { name: "v0.1.0", message: "Release v0.1.0" } },
    { at: "2026-08-26T11:00:00Z", author: "priya", message: "fix: say repository", branch: "fix/typo", changes: { "README.md": readme2 } },
    { at: "2026-08-27T12:00:00Z", author: "tomas", message: "Merge branch 'fix/typo'", branch: "main", merge: { from: "fix/typo", message: "Merge branch 'fix/typo'" } },
    { at: "2026-09-01T09:15:00Z", author: "mira", message: "feat: add feature module\n\nIntroduces the feature file and moves util to helpers.", branch: "feature/tiny", changes: { "src/feature.ts": feature1, "src/helpers.ts": { renameFrom: "src/util.ts" } } },
    { at: "2026-09-02T09:15:00Z", author: "daniel", message: "refactor: drop old module", changes: { "src/old.ts": null, "src/feature.ts": feature2 } },
    { at: "2026-09-03T16:45:00Z", author: "mira", message: "feat: third app version", changes: { "src/app.ts": app3 } },
  ],
  upstream: { ahead: 1, behind: 1 },
  upstreamExtra: [{ at: "2026-09-04T08:00:00Z", author: "priya", message: "docs: note on the remote", changes: { "docs/remote.md": "Remote-only note.\n" } }],
  remoteOnlyBranches: [{ name: "release/0.1", from: "v0.1.0" }],
  worktree: {
    modify: { "README.md": "# fb-tiny\n\nTiny demo repository (edited).\n", "src/greet.ts": greet("one", "two") },
    stage: ["src/greet.ts"],
    thenModify: { "src/greet.ts": greet("one", "two", "three") },
    stageAdd: { "src/new.ts": "export const fresh = true;\n" },
    delete: ["src/feature.ts"],
    stageRename: [{ from: "src/app.ts", to: "src/main.ts" }],
    untracked: { "notes.txt": "todo: nothing\n", "dump_2026-09-30/a.json": "{}\n", "dump_2026-09-30/b.json": "[]\n", ".env": "KEY=change-me\n" },
    hunkTargets: [{ path: "src/greet.ts", hunks: 3 }],
  },
  agentEdit: { path: "src/app.ts", before: 'export const app = "three";', after: 'export const app = "four";' },
  expect: {
    branch: "feature/tiny",
    ahead: 1,
    behind: 1,
    commits: [7, 7],
    merges: 1,
    tags: ["v0.1.0"],
    otherLocalBranches: ["fix/typo", "main"],
    merged: ["fix/typo"],
    remoteOnly: ["release/0.1"],
    worktree: { modified: 2, added: 1, deleted: 1, renamed: 1, partiallyStaged: 1, untrackedFiles: 1, untrackedDirs: { "dump_2026-09-30/": 2 }, untrackedNamed: [".env"] },
    someFileHunks: 3,
  },
};
