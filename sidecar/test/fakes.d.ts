declare module '*/fake-host.mjs' {
  export const FakeHost: any;
  export const mockStart: (agentId: string, scenario?: string, extra?: Record<string, any>) => any;
  export const MOCK_ROLE: any;
  export const SIDECAR: string;
  export const dropTranscripts: (cwd: string) => void;
}
declare module '*/hardstop-policy.mjs' {
  export const makePolicy: (o?: { askWrites?: boolean; log?: any[] }) => (req: any) => any;
  export const hardStopReason: (cmd: string) => string | null;
}
declare module '*/golden.mjs' {
  export const scan: (text: string, name?: string) => string[];
  export const sanitize: (m: any) => any;
}
