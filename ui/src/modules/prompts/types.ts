/** One saved prompt. Starter prompts ship with the app and are read-only; the person's own live in settings.json. */
export interface SavedPrompt {
  id: string;
  title: string;
  /** The text of the prompt; `{{selection}}`, `{{file}}`, `{{branch}}` and `{{repo}}` are filled in when it is used. */
  body: string;
  tags: string[];
  /** Milliseconds; 0 for a starter. */
  updatedAt: number;
}

/** Where a prompt lives: a starter, the person's own (every repository) or one repository's (keyed by repository id). */
export type PromptScope = { kind: "starter" } | { kind: "user" } | { kind: "repo"; repoId: string };

export interface ScopedPrompt extends SavedPrompt {
  scope: PromptScope;
}

/** settings.json, namespace `prompts`. Nothing is ever written into a repository. */
export interface PromptsSettings {
  user: SavedPrompt[];
  repos: Record<string, SavedPrompt[]>;
}

/** What the placeholders are filled with; a missing value leaves a short note instead. */
export interface PromptContext {
  selection?: string;
  file?: string;
  branch?: string;
  repo?: string;
}
