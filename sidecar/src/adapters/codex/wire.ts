// Codex app-server wire vocabulary (codex-cli 0.146.0, `codex app-server generate-json-schema --experimental`): JSONL JSON-RPC
// over stdio, no "jsonrpc" member. Method names are the ones recorded in (design notes: providers-plan) "Codex spike results".
export const MIN_VERSION = '0.146.0';

export type Json = Record<string, any>;
export const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Server -> client requests that need an answer; everything else a server asks gets a "method not found" error. */
export const REQ = {
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  permissions: 'item/permissions/requestApproval',
  userInput: 'item/tool/requestUserInput',
  elicitation: 'mcpServer/elicitation/request',
  dynamicTool: 'item/tool/call',
  legacyExec: 'execCommandApproval',
  legacyPatch: 'applyPatchApproval',
} as const;

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

/** -1, 0, 1 like a comparator; missing parts count as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
