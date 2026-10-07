// "Attach screenshot to the agent prompt": hands a PNG to the visible agent composer through the attachments module's
// drop router (the composer registered itself as a drop target `composer:agent:<id>`), so size caps, image processing and the
// provider's attachment rules all apply exactly as for a dropped file.
import { dropTargets, itemFromFile } from "../../platform/dropzone";

export type AttachOutcome = "attached" | "noAgent" | "refused";

export async function attachToAgentPrompt(file: File): Promise<AttachOutcome> {
  const item = itemFromFile(file);
  const targets = dropTargets()
    .filter((t) => t.id.startsWith("composer:agent:") && t.isActive())
    .sort((a, b) => b.priority - a.priority);
  const target = targets[0];
  if (!target) return "noAgent";
  if (!target.accepts([item])) return "refused";
  await target.onDrop([item]);
  return "attached";
}
