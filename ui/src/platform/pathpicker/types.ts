export type { PickKind, PickPurpose } from "../../ipc/picker";
import type { PickKind, PickPurpose } from "../../ipc/picker";

export interface PickOptions {
  kind: PickKind;
  purpose: PickPurpose;
  /** Dialog title; defaults to the kind's title. */
  title?: string;
  /** File kinds: the extensions to list (without the dot). */
  extensions?: string[];
  /** A token from an earlier pick: the dialog starts in that folder. */
  startToken?: string;
  /** The `Go to path` field (default true). */
  allowGoTo?: boolean;
}
