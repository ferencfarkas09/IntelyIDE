// Backend of the release assistant: `l10n_release_plan` / `l10n_release_apply` in the app, a deterministic fixture in a
// plain browser. Translating the entry reuses the localization module's `l10n_draft` backend.
import { call } from "../../ipc/rpc";
import { inTauri, l10nApi } from "../l10n/api";
import type { DraftItem, Drafted } from "../l10n/types";
import type { ApplyRequest, Bump, Plan } from "./types";

export interface ReleaseApi {
  plan(repoId: string, bump?: Bump): Promise<Plan>;
  apply(repoId: string, request: ApplyRequest): Promise<string[]>;
  translate(items: DraftItem[]): Promise<Drafted[]>;
}

const tauriApi: ReleaseApi = {
  plan: (repoId, bump) => call("l10n_release_plan", { repoId, bump: bump ?? null }),
  apply: (repoId, request) => call("l10n_release_apply", { repoId, request }),
  translate: (items) => l10nApi().draft(items),
};

let override: ReleaseApi | undefined;
export const setReleaseApi = (api: ReleaseApi | undefined): void => void (override = api);

let mock: ReleaseApi | undefined;
export function releaseApi(): ReleaseApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockRelease());
}

const bumpOf = (v: string, b: Bump): string => {
  const [a, m, p] = v.split(".").map(Number);
  return b === "major" ? `${a + 1}.0.0` : b === "minor" ? `${a}.${m + 1}.0` : `${a}.${m}.${p + 1}`;
};

export function createMockRelease(): ReleaseApi {
  const commits = [
    { hash: "a1b2c3d4e", subject: "let users edit their lead quick statuses", author: "Dev One", date: "2026-10-02", kind: "feature" as const, scope: "crm", breaking: false },
    { hash: "b2c3d4e5f", subject: "show the runtime logs tab with stored API process logs", author: "Dev Two", date: "2026-10-01", kind: "feature" as const, scope: "cicd", breaking: false },
    { hash: "c3d4e5f6a", subject: "stop the double click on save creating two invoices", author: "Dev One", date: "2026-09-30", kind: "fix" as const, scope: null, breaking: false },
    { hash: "d4e5f6a7b", subject: "tidy the order table spacing", author: "Dev Two", date: "2026-09-29", kind: "improvement" as const, scope: "orders", breaking: false },
  ];
  const plan = async (_repo: string, bump?: Bump): Promise<Plan> => {
    const b: Bump = bump ?? "minor";
    const proposed = bumpOf("3.88.7", b);
    const entry = {
      version: proposed,
      date: "2026-10-03",
      highlight: { en: "This release brings 2 new features, 1 improvements, 1 fixes." },
      groups: [
        { type: "feature", items: [{ title: { en: "Let users edit their lead quick statuses" } }, { title: { en: "Show the runtime logs tab with stored API process logs" } }] },
        { type: "improvement", items: [{ title: { en: "Tidy the order table spacing" } }] },
        { type: "fix", items: [{ title: { en: "Stop the double click on save creating two invoices" } }] },
      ],
    };
    return {
      versionFile: "package.json",
      changelogPath: "src/components/modules/whatsNew/changelog.json",
      current: "3.88.7",
      proposed,
      bump: b,
      baseKind: "versionCommit",
      base: "aa20f56c3",
      commits,
      langs: ["en", "hu", "de", "cz", "sk", "fr", "it", "es", "ro", "pl", "cn"],
      entry,
      tagHint: null,
      diff: `--- a/package.json\n+++ b/package.json\n-  "version": "3.88.7",\n+  "version": "${proposed}",\n--- a/src/components/modules/whatsNew/changelog.json\n+++ b/src/components/modules/whatsNew/changelog.json\n+    {\n+      "version": "${proposed}",\n+      "date": "2026-10-03",\n+      ...\n+    },`,
      notes: [],
    };
  };
  return {
    plan,
    apply: async (_repo, req) => (req.entry && req.changelogPath ? ["package.json", req.changelogPath] : ["package.json"]),
    translate: async (items) => items.map((i) => ({ id: i.id, text: `[${i.lang}] ${i.reference}`, valid: true, note: null })),
  };
}
