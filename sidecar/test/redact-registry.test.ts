import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HistoryService, type HistorySdk } from '../src/history.js';
import { ProtocolClient } from '../src/protocol.js';
import { deriveForms, redact, redactDeep, registerSecrets } from '../src/redact.js';

const CANARY = 'CANARY-MCP-7f3a-env';
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/protocol/fixtures/mcp-secret-forms.json', import.meta.url)), 'utf8')) as { value: string; forms: string[] }[];

describe('registerSecrets (MCP spec 5.5)', () => {
  it('replaces a registered value in a plain string, inside redactDeep and in an error text', () => {
    const dispose = registerSecrets([CANARY]);
    try {
      expect(redact(`failed with ${CANARY} twice ${CANARY}`)).toBe('failed with <redacted> twice <redacted>');
      expect(redactDeep({ a: [`x ${CANARY}`], b: { c: CANARY } })).toEqual({ a: ['x <redacted>'], b: { c: '<redacted>' } });
      expect(redact(`MCP error -32000: upstream said ${CANARY}`)).not.toContain(CANARY);
    } finally {
      dispose();
    }
  });

  it('a value under 4 characters only matches when the whole text equals it', () => {
    const dispose = registerSecrets(['ab']);
    try {
      expect(redact('a cab ab')).toBe('a cab ab');
      expect(redact('ab')).toBe('<redacted>');
    } finally {
      dispose();
    }
  });

  it('the disposer removes the value, and two sessions do not see each other after disposal', () => {
    const a = registerSecrets(['first-secret-aaaa']);
    const b = registerSecrets(['second-secret-bbbb', 'first-secret-aaaa']);
    expect(redact('x first-secret-aaaa y second-secret-bbbb')).toBe('x <redacted> y <redacted>');
    a();
    expect(redact('x first-secret-aaaa y second-secret-bbbb'), 'the value b also registered stays').toBe('x <redacted> y <redacted>');
    b();
    expect(redact('x first-secret-aaaa y second-secret-bbbb')).toBe('x first-secret-aaaa y second-secret-bbbb');
    expect(() => { a(); b(); }).not.toThrow();
  });

  it('catches the forms a server echoes: the bare token of a Bearer value, base64, percent-encoding, JSON escaping', () => {
    const basic = `Basic ${Buffer.from('alice:s3cret-pw').toString('base64')}`;
    const dispose = registerSecrets([`Bearer ${CANARY}`, basic, 'p@ss w/ord&more']);
    try {
      expect(redact(`header was Bearer ${CANARY}`)).not.toContain(CANARY);
      expect(redact(`token ${CANARY}`)).toBe('token <redacted>');
      expect(redact('basic user alice:s3cret-pw')).toBe('basic user <redacted>');
      expect(redact(`b64 ${Buffer.from('alice:s3cret-pw').toString('base64')}`)).toBe('b64 <redacted>');
      expect(redact('q=p%40ss%20w%2Ford%26more')).toBe('q=<redacted>');
      expect(redact(`json ${JSON.stringify('p@ss w/ord&more')}`)).toBe('json "<redacted>"');
    } finally {
      dispose();
    }
  });

  it('still runs the patterns for everything it does not know', () => {
    const dispose = registerSecrets([CANARY]);
    try {
      expect(redact(`${CANARY} Authorization: Bearer other.token.here`)).toBe('<redacted> Authorization: <redacted>');
    } finally {
      dispose();
    }
  });

  it('an empty registry costs nothing and changes nothing', () => {
    expect(redact('plain text, nothing here: 42')).toBe('plain text, nothing here: 42');
    registerSecrets([''])();
    expect(redact('abc')).toBe('abc');
  });
});

describe('deriveForms against the shared vectors (the Rust twin reads the same file)', () => {
  it('has vectors', () => expect(vectors.length).toBeGreaterThan(5));
  for (const v of vectors) {
    it(`derives the forms of ${JSON.stringify(v.value).slice(0, 40)}`, () => {
      expect(new Set(deriveForms(v.value))).toEqual(new Set(v.forms));
      expect(deriveForms(v.value).length).toBeLessThanOrEqual(8);
    });
  }
});

describe('history/messages with scrub (MCP spec 5.2 item 11)', () => {
  const transcript = (calls: unknown[][] = []): HistorySdk => ({
    listSessions: async () => [],
    getSessionMessages: async (id, o) => {
      calls.push([id, o]);
      return [{ type: 'user', uuid: 'u1', message: { content: `the server said ${CANARY} and key sk-ant-abcdefghijklmnop` } }];
    },
    tagSession: async () => {},
    renameSession: async () => {},
    forkSession: async () => ({ sessionId: 'f' }),
  });
  const call = async (sdk: HistorySdk, body: unknown) => {
    const sent: any[] = [];
    const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
    new HistoryService(proto, async () => sdk);
    proto.receive(JSON.stringify({ v: 1, id: 1, type: 'history/messages', body }));
    for (let i = 0; i < 200; i++) {
      const r = sent.find((m) => m.type === 'reply' && m.id === 1);
      if (r) return r.body;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error('no reply');
  };

  it('redacts a transcript text with the scrub list, and without it only the patterns apply', async () => {
    const without = await call(transcript(), { sessionId: 's1' });
    expect(without.messages[0].text).toContain(CANARY);
    expect(without.messages[0].text).toContain('<redacted:key>');
    const withScrub = await call(transcript(), { sessionId: 's1', scrub: [CANARY, 42, null] });
    expect(withScrub.messages[0].text).not.toContain(CANARY);
    expect(withScrub.messages[0].text).toBe('the server said <redacted> and key <redacted:key>');
    // registered for that one request only
    expect(redact(CANARY)).toBe(CANARY);
  });
});
