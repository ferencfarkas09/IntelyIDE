// Every limit in one place so the tests and the README quote the same numbers.
export const PROTOCOL = "intely.v1";
export const MAX_PHONES = 5;
export const MAX_BINARY_FRAME = 64 * 1024; // ciphertext frame cap (remote-plan 2.3)
export const MAX_CONTROL_FRAME = 8 * 1024; // plaintext control frames
export const MAX_SNAPSHOT_FRAME = 192 * 1024; // one encrypted snapshot (base64 inside JSON)
export const MAX_SNAPSHOT_BYTES = 128 * 1024; // decoded ciphertext
export const SNAPSHOT_MIN_INTERVAL_MS = 10_000; // rewritten at most every 10 s ...
export const SNAPSHOT_FORCE_INTERVAL_MS = 2_000; // ... unless the Mac marks a Needs-you change
export const QUEUE_MAX_FRAMES = 100;
export const QUEUE_MAX_BYTES = 1024 * 1024;
export const QUEUE_TTL_MS = 10 * 60_000; // stale approvals are never actionable
export const PAIR_MAX_TTL_MS = 120_000;
export const MIN_TOKEN_CHARS = 32;
export const MAX_PUSH_SUBS = 8;
export const NOTIFY_PER_MIN = 20;
export const AUTO_PING = "ping";
export const AUTO_PONG = "pong";
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX_MAC = 200; // frames per window (events are batched <= 4/s by the Mac)
export const RATE_MAX_PHONE = 60;
export const RATE_STRIKES_CLOSE = 3;

// Close codes (4000+ are application codes).
export const CLOSE_REPLACED = 4000;
export const CLOSE_REVOKED = 4401;
export const CLOSE_WIPED = 4410;
export const CLOSE_RATE = 1008;
