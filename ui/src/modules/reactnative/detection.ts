// Which repositories of the workspace are React Native or Expo apps. Small on purpose: the rail item and the palette command
// read it at startup, while the rest of the store (devices, logs, error cards) loads with the first use of the panel.
import { createSignal } from "solid-js";
import { devicesApi } from "./api";
import type { ProjectInfo } from "./types";

const [projects, setProjects] = createSignal<Record<string, ProjectInfo>>({});
const [repoId, setRepoId] = createSignal<string | undefined>();
let generation = 0;

export const projectsByRepo = projects;
export const detectedRepoIds = (): string[] => Object.keys(projects());
export const anyDetected = (): boolean => detectedRepoIds().length > 0;
export const selectedRepoId = (): string | undefined => {
  const chosen = repoId();
  const ids = detectedRepoIds();
  return chosen && ids.includes(chosen) ? chosen : ids[0];
};
export const selectedProject = (): ProjectInfo | undefined => {
  const id = selectedRepoId();
  return id ? projects()[id] : undefined;
};
export const selectRepo = (id: string): void => void setRepoId(id);

/** Detects the projects of these repositories (one that is none, or whose detection failed, is left out). The latest call wins. */
export async function detectProjects(repoIds: readonly string[]): Promise<void> {
  const mine = ++generation;
  const found: Record<string, ProjectInfo> = {};
  await Promise.all(
    repoIds.map(async (id) => {
      try {
        const p = await devicesApi().detect(id);
        if (p) found[id] = p;
      } catch {
        /* an unreadable repository is not a project */
      }
    }),
  );
  if (mine === generation) setProjects(found);
}

/** Test hook. */
export function resetDetection(): void {
  generation++;
  setProjects({});
  setRepoId(undefined);
}
