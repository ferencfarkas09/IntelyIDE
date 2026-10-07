// Session history for the Runs/History views (Alpha-E1): the Agent SDK's own transcript store (`~/.claude/projects`, or
// CLAUDE_CONFIG_DIR) read through listSessions/getSessionMessages, so sessions started outside the IDE show up too.
// Stateless: none of these requests needs an open session. The SDK is loaded (and verified) on the first request only.
import type { ProtocolClient } from './protocol.js';
import { redact, registerSecrets, truncate } from './redact.js';
import { loadSdk } from './sdk.js';

export interface SessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  createdAt?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  fileSize?: number;
}

export interface HistoryMessage {
  uuid: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Names of the tools an assistant message called. */
  tools: string[];
}

/** The slice of the Agent SDK this module uses (injectable for tests). */
export interface HistorySdk {
  listSessions(o?: { dir?: string; limit?: number; offset?: number; includeWorktrees?: boolean }): Promise<SessionInfo[]>;
  getSessionMessages(id: string, o?: { dir?: string; limit?: number; offset?: number }): Promise<{ type: 'user' | 'assistant' | 'system'; uuid: string; message: unknown }[]>;
  tagSession(id: string, tag: string | null, o?: { dir?: string }): Promise<void>;
  renameSession(id: string, title: string, o?: { dir?: string }): Promise<void>;
  forkSession(id: string, o?: { dir?: string; upToMessageId?: string; title?: string }): Promise<{ sessionId: string }>;
}

type Err = { error: string; detail?: string };
const MAX_LIST = 500;
const MAX_MESSAGES = 2000;
const MAX_TEXT = 20_000;

export function messageOf(m: { type: 'user' | 'assistant' | 'system'; uuid: string; message: unknown }): HistoryMessage {
  const content = (m.message as { content?: unknown } | null | undefined)?.content;
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const text = parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('\n');
  const tools = parts.filter((p) => p?.type === 'tool_use' && typeof p.name === 'string').map((p) => p.name as string);
  return { uuid: m.uuid, role: m.type, text: truncate(redact(text), MAX_TEXT), tools };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const int = (v: unknown, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : undefined);

export class HistoryService {
  private sdk?: Promise<HistorySdk>;

  constructor(proto: ProtocolClient, private load: () => Promise<HistorySdk> = () => loadSdk() as unknown as Promise<HistorySdk>) {
    proto.on('history/list', (b) => this.run(() => this.list(b)));
    proto.on('history/messages', (b) => this.run(() => this.messages(b)));
    proto.on('history/tag', (b) => this.run(() => this.tag(b)));
    proto.on('history/rename', (b) => this.run(() => this.rename(b)));
    proto.on('history/fork', (b) => this.run(() => this.fork(b)));
  }

  private sdkOnce(): Promise<HistorySdk> {
    // only a success stays cached: a missing SDK must be found after the user installs it (Re-check)
    return (this.sdk ??= this.load().catch((e) => { this.sdk = undefined; throw e; }));
  }

  private async run<T>(f: () => Promise<T>): Promise<T | Err> {
    try { return await f(); } catch (e) { return { error: 'history', detail: redact((e as Error).message) }; }
  }

  private async list(b: { dir?: string; limit?: number; offset?: number }) {
    const sdk = await this.sdkOnce();
    const sessions = await sdk.listSessions({ ...(str(b.dir) ? { dir: b.dir } : {}), limit: int(b.limit, MAX_LIST) ?? 200, offset: int(b.offset, 1_000_000) ?? 0 });
    return {
      ok: true as const,
      sessions: sessions.map((s): SessionInfo => ({
        sessionId: s.sessionId, summary: truncate(redact(s.summary ?? ''), 300), lastModified: s.lastModified,
        ...(s.createdAt ? { createdAt: s.createdAt } : {}), ...(s.customTitle ? { customTitle: truncate(redact(s.customTitle), 300) } : {}),
        ...(s.firstPrompt ? { firstPrompt: truncate(redact(s.firstPrompt), 300) } : {}), ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
        ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.tag ? { tag: s.tag } : {}), ...(typeof s.fileSize === 'number' ? { fileSize: s.fileSize } : {}),
      })),
    };
  }

  /**
   * `scrub` (optional, MCP spec 5.5): exact secret values of the run's MCP servers. They are registered for the duration of THIS request only,
   * so a secret a server echoed into the transcript does not show unredacted after a restart (the patterns alone cannot know it).
   */
  private async messages(b: { sessionId: string; dir?: string; limit?: number; offset?: number; scrub?: unknown }) {
    if (!str(b.sessionId)) return { error: 'badRequest', detail: 'sessionId' };
    const sdk = await this.sdkOnce();
    const dispose = Array.isArray(b.scrub) ? registerSecrets(b.scrub.filter((v): v is string => typeof v === 'string').slice(0, 256)) : undefined;
    try {
      const raw = await sdk.getSessionMessages(b.sessionId, { ...(str(b.dir) ? { dir: b.dir } : {}), limit: int(b.limit, MAX_MESSAGES) ?? 500, offset: int(b.offset, 1_000_000) ?? 0 });
      return { ok: true as const, messages: raw.map(messageOf) };
    } finally {
      dispose?.();
    }
  }

  private async tag(b: { sessionId: string; tag: string | null; dir?: string }) {
    if (!str(b.sessionId)) return { error: 'badRequest', detail: 'sessionId' };
    const tag = b.tag === null ? null : str(b.tag)?.trim().slice(0, 64) ?? null;
    await (await this.sdkOnce()).tagSession(b.sessionId, tag, str(b.dir) ? { dir: b.dir } : {});
    return { ok: true as const };
  }

  private async rename(b: { sessionId: string; title: string; dir?: string }) {
    const title = str(b.title)?.trim().slice(0, 200);
    if (!str(b.sessionId) || !title) return { error: 'badRequest', detail: 'sessionId and title' };
    await (await this.sdkOnce()).renameSession(b.sessionId, title, str(b.dir) ? { dir: b.dir } : {});
    return { ok: true as const };
  }

  private async fork(b: { sessionId: string; dir?: string; upToMessageId?: string; title?: string }) {
    if (!str(b.sessionId)) return { error: 'badRequest', detail: 'sessionId' };
    const r = await (await this.sdkOnce()).forkSession(b.sessionId, { ...(str(b.dir) ? { dir: b.dir } : {}), ...(str(b.upToMessageId) ? { upToMessageId: b.upToMessageId } : {}), ...(str(b.title) ? { title: b.title } : {}) });
    return { ok: true as const, sessionId: r.sessionId };
  }
}
