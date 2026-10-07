// Fake stand-in for the Claude Agent SDK (tests only): same export names the sidecar uses, no behaviour.
import { dep } from 'fake-dep';
export const fakeSdk = true;
export const depSeen = dep;
export function query() { throw new Error('fake sdk: query is not implemented'); }
export async function listSessions() { return []; }
