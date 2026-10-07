// Mock scenario format: JSONL, one step per line, `dt` = delay in ms before the step (scaled by `speed`), `{"op":"turn"}` starts the
// script of the next prompt. Steps: text think start tool ask question emit usage error status plan label goto end, and the delegation
// ops delegate / call / enddelegate (real policy.decide with an actor, see session.ts) and `exitplan` (the lead's ExitPlanMode approval card).
export type Step = { op: string; dt?: number; [k: string]: any };

const OPS = new Set(['text', 'think', 'start', 'tool', 'ask', 'question', 'emit', 'usage', 'error', 'status', 'plan', 'label', 'goto', 'end', 'wait', 'delegate', 'call', 'enddelegate', 'exitplan']);

/** Parses JSONL into one step list per turn. Throws on unknown ops or bad JSON so a broken script fails at open, not mid-run. */
export function parseScript(text: string): Step[][] {
  const turns: Step[][] = [[]];
  text.split('\n').forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    let s: Step;
    try { s = JSON.parse(line); } catch { throw new Error(`mock script line ${n + 1}: invalid JSON`); }
    if (s.op === 'turn') { turns.push([]); return; }
    if (!OPS.has(s.op)) throw new Error(`mock script line ${n + 1}: unknown op "${s.op}"`);
    turns[turns.length - 1].push(s);
  });
  return turns.filter((t) => t.length);
}
