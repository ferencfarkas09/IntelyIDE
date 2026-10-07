// Golden fixture hygiene (providers-plan 5.8): sanitize() strips what must never be committed from recorded SDK/ACP streams,
// scan() is the check the vitest scan test and `sanitize-golden.mjs --check` share. Pure functions over parsed JSON lines.

/** Built-in subagent names that are part of the CLI itself (everything else in init.agents is user inventory). */
export const BUILTIN_AGENTS = new Set(['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup', 'echoer']);

const HOME = /\/Users\/[^/\s"']+/g;
const TMP = /\/(?:private\/)?var\/folders\/[^/\s"']+\/[^/\s"']+\/T\//g;
const CLAUDE_TMP = /\/private\/tmp\/claude-\d+\//g;
const SOCK = /\/tmp\/cc-socks\/\d+\.sock/g;
const PLUGIN_PATH = /<home>\/\.claude\/plugins\/(?:cache|synced|marketplaces)\/[^"'\s]*/g;
const PROJECT_DIR = /<home>\/\.claude\/projects\/[^/"'\s]+\//g;

export function cleanString(s) {
  return s
    .replace(HOME, '<home>')
    .replace(PLUGIN_PATH, '<plugin>')
    .replace(PROJECT_DIR, '<home>/.claude/projects/<project>/')
    .replace(TMP, '<tmp>/')
    .replace(CLAUDE_TMP, '<claude-tmp>/')
    .replace(SOCK, '<sock>');
}

/** Opaque provider blobs (thinking signatures) look like tokens and carry no value for mapping tests. */
const BLOB_KEYS = new Set(['signature']);

function walk(v, key) {
  if (typeof v === 'string') return BLOB_KEYS.has(key) && v.length > 40 ? '<signature>' : cleanString(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, k);
    return o;
  }
  return v;
}

/** Returns the sanitized copy of one recorded message. */
export function sanitize(msg) {
  const m = walk(msg);
  if (m.type === 'system') {
    if (m.subtype === 'init') {
      m.slash_commands = [];
      m.skills = [];
      if (Array.isArray(m.agents)) m.agents = m.agents.filter((a) => BUILTIN_AGENTS.has(a));
      if (Array.isArray(m.tools)) m.tools = m.tools.filter((t) => !/^mcp__/.test(t));
      if (Array.isArray(m.mcp_servers)) m.mcp_servers = m.mcp_servers.map((s, i) => ({ ...s, name: `mcp-${i + 1}` }));
      if (Array.isArray(m.plugins)) {
        let n = 0;
        m.plugins = m.plugins.map((p) => (p.path === 'builtin' ? p : { name: `plugin-${++n}`, path: '<plugin>', source: 'plugin' }));
      }
    }
    if (m.subtype === 'commands_changed') m.commands = [];
    if (m.subtype === 'informational') m.content = '<redacted>';
    if (/^hook_/.test(m.subtype ?? '')) for (const k of ['output', 'stdout', 'stderr']) if (m[k]) m[k] = '<redacted>';
  }
  return m;
}

const TOKEN_RULES = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, 'anthropic key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'api key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/, 'github token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'aws key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'slack token'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'jwt'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/, 'bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/(?:api[_-]?key|secret|password|passwd)["']?\s*[:=]\s*["'][^"']{8,}["']/i, 'secret assignment'],
  [/[A-Za-z0-9+/]{80,}={0,2}/, 'long base64 blob'],
  [/\b[0-9a-f]{40,}\b/, 'long hex blob'],
];
const PATH_RULES = [
  [/\/Users\//, 'home path'], [/\/home\/[a-z]/, 'home path'], [/\/(?:private\/)?var\/folders\//, 'macOS temp path'], [/\/private\/tmp\/claude-/, 'claude temp path'],
  [/\.claude\/plugins\/(?:cache|synced)/, 'plugin cache path'],
];

/** Lists problems in one JSONL text. An empty array means the file is clean. */
export function scan(text, name = 'file') {
  const bad = [];
  for (const [re, what] of [...TOKEN_RULES, ...PATH_RULES]) {
    const hit = re.exec(text);
    if (hit) bad.push(`${name}: ${what} (${hit[0].slice(0, 24)}...)`);
  }
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { bad.push(`${name}:${i + 1}: not JSON`); return; }
    if (m.type !== 'system') return;
    const at = `${name}:${i + 1}`;
    if (m.subtype === 'init') {
      if (m.slash_commands?.length) bad.push(`${at}: slash command inventory`);
      if (m.skills?.length) bad.push(`${at}: skill inventory`);
      for (const a of m.agents ?? []) if (!BUILTIN_AGENTS.has(a)) bad.push(`${at}: agent inventory "${a}"`);
      for (const t of m.tools ?? []) if (/^mcp__/.test(t)) bad.push(`${at}: MCP tool name "${t}"`);
      for (const s of m.mcp_servers ?? []) if (!/^mcp-\d+$/.test(s.name)) bad.push(`${at}: MCP server name "${s.name}"`);
      for (const p of m.plugins ?? []) if (p.path !== 'builtin' && !/^plugin-\d+$/.test(p.name)) bad.push(`${at}: plugin name "${p.name}"`);
    }
    if (m.subtype === 'commands_changed' && m.commands?.length) bad.push(`${at}: command inventory`);
    if (m.subtype === 'informational' && m.content !== '<redacted>') bad.push(`${at}: informational text`);
    if (/^hook_/.test(m.subtype ?? '')) for (const k of ['output', 'stdout', 'stderr']) if (m[k] && m[k] !== '<redacted>') bad.push(`${at}: hook ${k}`);
  });
  return bad;
}
