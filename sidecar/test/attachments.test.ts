// Attachments -> SDK user content, and the user.message event metadata (never paths).
import { describe, expect, it } from 'vitest';
import { buildContent, fenced } from '../src/adapters/claude-sdk/attachments.js';
import { SidecarHost } from '../src/host.js';
import { Loader } from '../src/loader.js';
import { ProtocolClient } from '../src/protocol.js';
import type { AgentProvider, PromptAttachment, UserInput, WireEvent } from '../src/types.js';

const att = (o: Partial<PromptAttachment>): PromptAttachment => ({ id: 'a', name: 'f', mime: 'text/plain', size: 3, kind: 'text', sha256: 'x', path: '/store/f', ...o });
const files: Record<string, string> = { '/store/img.png': 'PNGDATA', '/store/doc.pdf': 'PDFDATA', '/store/notes.md': '# hi', '/store/big.bin': 'BIN' };
const read = (p: string) => Buffer.from(files[p] ?? '');

describe('buildContent', () => {
  it('is the plain string without attachments', () => expect(buildContent('hi', undefined)).toBe('hi'));
  it('maps images and pdfs to base64 blocks, small text inline, the rest by path', () => {
    const c = buildContent('look', [att({ kind: 'image', mime: 'image/png', name: 'img.png', path: '/store/img.png' }), att({ kind: 'pdf', mime: 'application/pdf', name: 'doc.pdf', path: '/store/doc.pdf' }), att({ name: 'notes.md', path: '/store/notes.md' }), att({ kind: 'file', mime: 'application/octet-stream', name: 'big.bin', path: '/store/big.bin' })], read) as any[];
    expect(c[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } });
    expect(c[1]).toMatchObject({ type: 'document', title: 'doc.pdf', source: { media_type: 'application/pdf' } });
    expect(c[2].text).toContain('File: notes.md');
    expect(c[2].text).toContain('# hi');
    expect(c[3].text).toContain('- /store/big.bin');
    expect(c[4]).toEqual({ type: 'text', text: 'look' });
  });
  it('sends an unsupported image type and text over the inline cap by path, and survives an unreadable file', () => {
    const c = buildContent('', [att({ kind: 'image', mime: 'image/heic', path: '/store/h.heic' }), att({ size: 300 * 1024, path: '/store/t.txt' }), att({ path: '/nope' })], () => { throw new Error('ENOENT'); }) as any[];
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain('/store/h.heic');
    expect(c[0].text).toContain('/store/t.txt');
    expect(c[0].text).toContain('/nope');
  });
  it('uses a fence longer than any backtick run in the file', () => {
    expect(fenced('a.md', 'x ```js\ny\n``` z')).toContain('````\nx ```js');
  });
});

describe('host', () => {
  it('logs attachment metadata without the path and passes the paths to the session', async () => {
    const sent: any[] = [];
    const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
    let got: UserInput | undefined;
    const provider: AgentProvider = {
      id: 'stub', kind: 'cli', detect: async () => ({ installed: true, auth: 'ok' }), capabilities: () => ({}) as never, listModels: async () => [],
      open: async (_s, sink) => ({ nativeId: 'n', prompt: (i) => { got = i; sink.emit({ kind: 'turn.end', stopReason: 'endTurn' }); }, interrupt: async () => {}, answer: () => {}, close: async () => {} }),
    };
    const host = new SidecarHost(proto, new Loader({ stub: async () => ({ default: provider }) }, ['stub']));
    const orig = proto.request.bind(proto);
    (proto as any).request = (t: string, b: unknown) => (t === 'slot/acquire' ? Promise.resolve({ leaseId: 'L', ttlMs: 15000 }) : orig(t as never, b as never));
    const send = (id: number, type: string, body: unknown) => proto.receive(JSON.stringify({ v: 1, id, type, body }));
    send(1, 'session/start', { agentId: 'a1', provider: 'stub', role: { name: 'r', model: 'm', permission: 'ask' }, cwd: '/', env: {}, auth: { mode: 'subscription', key: null } });
    await new Promise((r) => setTimeout(r, 10));
    send(2, 'session/prompt', { agentId: 'a1', text: 'see', attachments: [att({ id: 'z', name: 'a.png', kind: 'image', mime: 'image/png', path: '/secret/place/a.png' })] });
    await new Promise((r) => setTimeout(r, 20));
    const um = sent.filter((m) => m.type === 'events/batch').flatMap((m) => m.body.events as WireEvent[]).find((e) => e.kind === 'user.message') as any;
    expect(um.attachments).toEqual([{ id: 'z', name: 'a.png', mime: 'image/png', size: 3, kind: 'image', sha256: 'x' }]);
    expect(JSON.stringify(um)).not.toContain('/secret/place');
    expect(got?.attachments?.[0].path).toBe('/secret/place/a.png');
    void host;
  });
});
