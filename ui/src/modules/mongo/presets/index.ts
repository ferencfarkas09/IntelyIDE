// UI side of the domain presets (the Rust side is crates/mongo/src/presets). A preset only carries wording and hints: it never
// changes what the privacy model sends. A profile saved before presets existed has no domain and is read as Happy (D14).
import type { Domain } from "../../../ipc/mongo";
import { generic } from "./generic";
import { happy } from "./happy";

export interface Preset {
  id: Domain;
  /** Field names that probably hold the tenant (the digest shows a hint chip). */
  tenantCandidates: readonly string[];
  /** Questions the AI bar cycles through as placeholders. */
  samplePrompts: readonly string[];
  /** Placeholder of the connection-name field. */
  namePlaceholder: string;
  /** Placeholder of the tenant-lock field. */
  tenantPlaceholder: string;
  /** IANA zone the date chips are shown in; `undefined` = the viewer's own zone. */
  timeZone: string | undefined;
}

export { generic, happy };

export const presetOf = (domain: Domain | null | undefined): Preset => (domain === "happy" ? happy : generic);

/** The Happy preset is offered for new profiles only when `mongo.happyPreset` is on, or when the profile already uses it. */
export const presetChoices = (happyPreset: boolean, current: Domain | null | undefined): Domain[] => (happyPreset || current === "happy" ? ["generic", "happy"] : ["generic"]);
