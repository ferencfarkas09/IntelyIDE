/** Hash routes (`#/`, `#/settings`, `#/run/<id>`): the system back gesture works and a deep link from a push opens the card. */
export const go = (hash: string): void => void (location.hash = hash);
export const runHref = (agentId: string): string => `#/run/${encodeURIComponent(agentId)}`;
