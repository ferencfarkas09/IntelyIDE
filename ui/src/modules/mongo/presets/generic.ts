// The Generic preset: no assumption about the data or the language of the person asking ((design notes: mongo-everyone-spec) 5.9).
import type { Preset } from "./index";

export const generic: Preset = {
  id: "generic",
  tenantCandidates: ["tenantId", "tenant_id", "orgId", "organizationId", "accountId"],
  samplePrompts: [
    "Open orders from the last 7 days over 100",
    "The 20 most recent cancelled orders",
    "Customers without an email address",
    "Events of type login from yesterday",
    "Products that are not active",
  ],
  namePlaceholder: "My database",
  tenantPlaceholder: "tenantId",
  timeZone: undefined,
};
