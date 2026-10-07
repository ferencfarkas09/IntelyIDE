// Shared shapes of the attachments module. `Meta` mirrors crates/attachments (serde camelCase).
import { t } from "../../i18n";
export type AttachKind = "image" | "text" | "pdf" | "file";

export interface GuardWarning {
  /** secret | neverAdd | neverRead | key */
  reason: string;
  detail: string;
}

export interface Meta {
  id: string;
  draftId: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachKind;
  sha256: string;
  createdMs: number;
  guard?: GuardWarning | null;
  confirmed: boolean;
  inline: boolean;
}

/** The attachments of a composer draft that go with a message (`agent_send`). */
export interface FileSelection {
  draftId: string;
  ids: string[];
}

export interface Imported {
  meta: Meta;
  deduped: boolean;
}

export interface Inspected {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  guard?: GuardWarning | null;
}

export interface PathImport {
  path: string;
  imported?: Imported | null;
  error?: { code: string; message: string } | null;
}

/** What the composer holds per chip: stored files, plus folder references that live only in the UI. */
export interface Attachment {
  /** Store id, or `folder:<path>` for a folder reference. */
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachKind | "folder";
  status: "processing" | "ready" | "error";
  error?: string;
  guard?: GuardWarning | null;
  confirmed: boolean;
  /** Object URL of an image thumbnail (revoked on remove). */
  thumb?: string;
  /** Folder reference: absolute path (inside a registered repo). */
  path?: string;
  repoId?: string;
  relPath?: string;
  /** Note shown on the chip, e.g. "resized to 1568 px". */
  note?: string;
  inline?: boolean;
}

export const FILE_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  imageMaxSide: 1568,
  pdfBytes: 10 * 1024 * 1024,
  textInlineBytes: 200 * 1024,
  fileBytes: 25 * 1024 * 1024,
} as const;

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const providerLabel = (provider: string | undefined): string => (provider === "claude" ? "Anthropic (Claude)" : provider === "mock" ? t("attach.provider.mock") : (provider ?? t("attach.provider.generic")));
