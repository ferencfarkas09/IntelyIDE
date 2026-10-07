// Attachments -> SDK user-message content (alpha Attachments). Streaming-input mode takes `content` as a string or an
// array of blocks: images and PDFs go in as base64 blocks, small text files are inlined as fenced blocks with the
// file name, everything else is listed by absolute path (the attachment store is a read-only additionalDirectories
// entry of the session, see agent_host). Pure apart from the injected reader, so it is unit-testable.
import { readFileSync } from 'node:fs';
import type { PromptAttachment } from '../../types.js';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMime; data: string } }
  | { type: 'document'; title?: string; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const IMAGE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_INLINE_TEXT = 200 * 1024;

/** A fence longer than any backtick run in the text, so file contents cannot break out of the block. */
export function fenced(name: string, body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `File: ${name}\n${fence}\n${body}\n${fence}`;
}

export function buildContent(text: string, attachments: PromptAttachment[] | undefined, read: (path: string) => Buffer = (p) => readFileSync(p)): string | ContentBlock[] {
  if (!attachments?.length) return text;
  const blocks: ContentBlock[] = [];
  const byPath: PromptAttachment[] = [];
  for (const a of attachments) {
    try {
      if (a.kind === 'image' && IMAGE_TYPES.has(a.mime)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime as ImageMime, data: read(a.path).toString('base64') } });
      } else if (a.kind === 'pdf') {
        blocks.push({ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: read(a.path).toString('base64') } });
      } else if (a.kind === 'text' && a.size <= MAX_INLINE_TEXT) {
        blocks.push({ type: 'text', text: fenced(a.name, read(a.path).toString('utf8')) });
      } else {
        byPath.push(a);
      }
    } catch {
      byPath.push(a); // unreadable here: leave a path reference rather than dropping the file silently
    }
  }
  if (byPath.length) {
    blocks.push({ type: 'text', text: `Attached files (read-only, read them with your file tools):\n${byPath.map((a) => `- ${a.path} (${a.name}, ${a.size} bytes)`).join('\n')}` });
  }
  if (text.trim()) blocks.push({ type: 'text', text });
  return blocks;
}
