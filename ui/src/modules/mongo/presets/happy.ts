// The Happy preset (default off for strangers, on for profiles that existed before presets, D14): the maintainer's own
// wording, Hungarian sample prompts and the tenant fields of the Happy collections.
import type { Preset } from "./index";

export const happy: Preset = {
  id: "happy",
  tenantCandidates: ["restaurant", "restaurantId", "tenant", "tenantId", "shop", "shopId"],
  samplePrompts: [
    "Az elmúlt 7 nap lezárt rendelései 10 000 Ft felett",
    "A legutóbbi 20 nyitott rendelés",
    "Vendégek e-mail cím nélkül",
    "Open orders from the last 3 days",
    "Legutóbbi 20 sztornózott rendelés",
  ],
  namePlaceholder: "Happy production",
  tenantPlaceholder: "restaurant",
  timeZone: "Europe/Budapest",
};
