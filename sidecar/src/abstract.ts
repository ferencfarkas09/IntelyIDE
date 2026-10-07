// Vocabulary of the roles (providers-plan 2.2) as the adapters meet it: provider wording in, abstract values out.
import type { Effort, PermissionMode } from './types.js';

/** Mirror of `PermissionMode::is_writer` (crates/agent_core/src/providers.rs): the modes that edit files without a card per edit. */
export const isWriterMode = (p: PermissionMode): boolean => p === 'edit' || p === 'automatic' || p === 'bypass';

/** Mirror of `PermissionMode::is_unattended`: Rust never asks in these modes, so the sidecar never shows a card in them. */
export const isUnattended = (p: PermissionMode): boolean => p === 'automatic' || p === 'bypass';

/** A provider that cannot do what a mode (or a live switch) asks; `session/permission` answers it as `unsupported`, not `rejected`. */
export class UnsupportedModeError extends Error {}

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** A level of the abstract ladder, or null for anything the CLI words differently. */
export function effortOf(level: string | null | undefined): Effort | null {
  return level && EFFORTS.includes(level) ? (level as Effort) : null;
}
