// The `mongo` settings namespace as the connection manager uses it: the default AI mode, the Happy preset switch, the
// first-run flag and the collapsed groups. Everything here is cosmetic and unsigned (spec 5.5).
import { ipc } from "../../../ipc";
import type { AiMode } from "../../../ipc/mongo";

export interface MongoPrefs {
  defaultAi: AiMode;
  happyPreset: boolean;
  onboardingDone: boolean;
  groupsCollapsed: string[];
}

const LS_COLLAPSED = "intely.mongo.groupsCollapsed";

const aiMode = (v: unknown): AiMode => (v === "schemaOnly" || v === "schemaEnums" ? v : "off");

function storedCollapsed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_COLLAPSED) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Rejects when settings.json cannot be read (the caller shows the Retry state). */
export async function readPrefs(): Promise<MongoPrefs> {
  const v = (await ipc.settings.get("mongo")) as Record<string, unknown>;
  const fromSettings = Array.isArray(v.groupsCollapsed) ? v.groupsCollapsed.filter((x): x is string => typeof x === "string") : undefined;
  return { defaultAi: aiMode(v.defaultAi), happyPreset: v.happyPreset === true, onboardingDone: v.onboardingDone === true, groupsCollapsed: fromSettings ?? storedCollapsed() };
}

export async function patchPrefs(patch: Partial<MongoPrefs>): Promise<void> {
  if (patch.groupsCollapsed) {
    try {
      localStorage.setItem(LS_COLLAPSED, JSON.stringify(patch.groupsCollapsed));
    } catch {
      /* private window: the settings copy below is the real one */
    }
  }
  await ipc.settings.set("mongo", patch as never);
}
