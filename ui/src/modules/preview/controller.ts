// The mounted preview view(s) register what the palette commands may drive. The last view mounted is the target.
import { createSignal } from "solid-js";

export interface PreviewController {
  repoId: string;
  reload(): void;
  hardReload(): void;
  rotate(): void;
  focusUrl(): void;
}

const [controllers, setControllers] = createSignal<readonly PreviewController[]>([]);

export function registerController(c: PreviewController): () => void {
  setControllers((all) => [...all, c]);
  return () => setControllers((all) => all.filter((x) => x !== c));
}

export const activeController = (): PreviewController | undefined => controllers().at(-1);
export const hasController = (): boolean => controllers().length > 0;
