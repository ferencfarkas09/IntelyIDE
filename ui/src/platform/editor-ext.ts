import type { Extension } from "@codemirror/state";
import { createRegistry } from "./registry";

export interface EditorFile {
  repoId: string;
  /** Repo-relative, `/`-separated. */
  path: string;
  /** The `language` the engine reports for the file, when known. */
  language?: string;
}

export interface EditorExtension {
  id: string;
  /** Which files get the extension. */
  when: (file: EditorFile) => boolean;
  /** Dynamic import of heavy CodeMirror packages goes here; it runs only when a matching file is opened, and gets that file. */
  extension: (file: EditorFile) => Promise<Extension>;
}

const registry = createRegistry<EditorExtension>(() => 0, "editor-extension");

export const registerEditorExtension = registry.register;
export const editorExtensions = registry.items;

/** All extensions for a file. One that rejects is skipped (and logged) so a broken module cannot stop the editor from opening. */
export async function extensionsFor(file: EditorFile): Promise<Extension[]> {
  const loaded = await Promise.all(
    registry
      .items()
      .filter((e) => e.when(file))
      .map(async (e) => {
        try {
          return await e.extension(file);
        } catch (err) {
          console.error(`Editor extension "${e.id}" failed to load`, err);
          return null;
        }
      }),
  );
  return loaded.filter((e): e is Extension => e !== null);
}

export const resetEditorExtensions = registry.clear;
