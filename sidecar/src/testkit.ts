// Surface for scripts/ (record-golden, enforcement-suite) that need the real adapter in-process with a raw-message tap.
export { ClaudeSession } from './adapters/claude-sdk/session.js';
export { mapRaw, newMapState } from './adapters/claude-sdk/map.js';
export { SeqSink, TurnGuard, checkInvariants } from './turn.js';
export { buildChildEnv } from './env.js';
