import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../src/env.js';
import { redact, redactDeep } from '../src/redact.js';

const host = {
  PATH: '/usr/bin:/bin', HOME: '/h', LANG: 'C',
  CLAUDECODE: '1', CLAUDE_EFFORT: 'high', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_CONFIG_DIR: '/cfg',
  INTELY_HUMAN_TOKEN: 'secret', INTELY_REAL_GIT: '/usr/bin/git',
  ANTHROPIC_API_KEY: 'sk-ant-api03-stray', ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_AUTH_TOKEN: 't',
  OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', GH_TOKEN: 'gh', GITHUB_TOKEN: 'gh', SSH_AUTH_SOCK: '/tmp/agent', COPILOT_GITHUB_TOKEN: 'c',
  MY_SERVICE_TOKEN: 'x', DB_PASSWORD: 'p',
};

describe('env scrub (providers-plan 4.2)', () => {
  it('drops host-session, foreign-provider and credential variables in subscription mode', () => {
    const b = buildChildEnv({ vars: host }, { mode: 'subscription', key: null }, { addDirs: false });
    for (const k of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'INTELY_HUMAN_TOKEN', 'INTELY_REAL_GIT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'COPILOT_GITHUB_TOKEN', 'MY_SERVICE_TOKEN', 'DB_PASSWORD']) {
      expect(b.env[k], k).toBeUndefined();
      expect(b.scrubbed).toContain(k);
    }
    expect(b.env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/h', LANG: 'C', CLAUDE_CONFIG_DIR: '/cfg' });
  });

  it('keeps only the chosen credential in apiKey mode', () => {
    const b = buildChildEnv({ vars: host }, { mode: 'apiKey', key: 'sk-ant-api03-chosen' }, { addDirs: false });
    expect(b.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-chosen');
    expect(b.env.OPENAI_API_KEY).toBeUndefined();
    expect(b.added).toContain('ANTHROPIC_API_KEY');
  });

  it('never leaks values into the reported lists', () => {
    const b = buildChildEnv({ vars: host }, { mode: 'apiKey', key: 'sk-ant-api03-chosen' }, { addDirs: true });
    expect(JSON.stringify([b.scrubbed, b.added])).not.toMatch(/sk-ant|secret|stray/);
  });

  it('switches the CLI background tasks off, whatever the host environment says (a run lives inside its turns)', () => {
    const on = buildChildEnv({ vars: { ...host, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } }, { mode: 'subscription', key: null }, { addDirs: false });
    expect(on.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1'); // not on the allow-list, and set on purpose
    expect(on.added).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    expect(buildChildEnv({ vars: host }, { mode: 'apiKey', key: 'sk-ant-api03-chosen' }, { addDirs: true }).env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it('adds AskUserQuestion and add-dir CLAUDE.md flags, and the shim first in PATH', () => {
    const b = buildChildEnv({ vars: host, shimDir: '/ide/shim' }, { mode: 'subscription', key: null }, { addDirs: true });
    expect(b.env.CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL).toBe('1');
    expect(b.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(b.env.PATH.split(':')[0]).toBe('/ide/shim');
    const without = buildChildEnv({ vars: host }, { mode: 'subscription', key: null }, { addDirs: false });
    expect(without.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBeUndefined();
  });
});

describe('env allow-list (SEC-6)', () => {
  it('lets nothing through that is not on the allow-list, whatever it is called', () => {
    const dirty = {
      PATH: '/usr/bin', HOME: '/h', USER: 'u', LC_ALL: 'C', TMPDIR: '/t', NVM_DIR: '/n',
      DATABASE_URL: 'postgres://u:CANARY@h/db', MONGODB_URI: 'mongodb+srv://u:CANARY@h', SENTRY_DSN: 'https://CANARY@sentry.io/1', GIT_ASKPASS: '/x/CANARY',
      PRIVATE_KEY: 'CANARY', STRIPE_KEY: 'CANARY', NPM_CONFIG__AUTH: 'CANARY', AWS_ACCESS_KEY_ID: 'CANARY', GIT_CONFIG_GLOBAL: '/CANARY', REDIS_URL: 'CANARY',
    };
    const b = buildChildEnv({ vars: dirty }, { mode: 'subscription', key: null }, { addDirs: false });
    expect(JSON.stringify(b.env)).not.toContain('CANARY');
    expect(Object.keys(b.env).filter((k) => !k.startsWith('CLAUDE_CODE_')).sort()).toEqual(['HOME', 'LC_ALL', 'NVM_DIR', 'PATH', 'TMPDIR', 'USER']);
    expect(b.scrubbed).toEqual(expect.arrayContaining(['DATABASE_URL', 'MONGODB_URI', 'SENTRY_DSN', 'GIT_ASKPASS', 'PRIVATE_KEY', 'STRIPE_KEY', 'NPM_CONFIG__AUTH']));
  });
});

describe('redaction', () => {
  it('masks URI credentials, PEM blocks, Stripe keys, *_KEY secrets, DSNs and short passwords (SEC-7)', () => {
    const samples: [string, string][] = [
      ['mongodb+srv://admin:CANARYpw@cluster0.example.net/db', 'CANARYpw'],
      ['postgres://u:s3cr3t@localhost:5432/app', 's3cr3t'],
      ['https://abc123canary@o1.ingest.sentry.io/42', 'abc123canary'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nCANARYBODY\n-----END RSA PRIVATE KEY-----', 'CANARYBODY'],
      ['-----BEGIN PRIVATE KEY-----\nCANARYTRUNC', 'CANARYTRUNC'],
      ['key sk_live_CANARY1234567890 here', 'CANARY1234567890'],
      ['STRIPE_SECRET_KEY=whatever_value_9', 'whatever_value_9'],
      ['aws_secret_access_key = wJalrCANARYsecret/K7MDENG', 'wJalrCANARYsecret'],
      ['DB_PASSWORD=abc', '=abc'],
      ['{"password": "pw1"}', 'pw1'],
      ['{"token":"CANARYtoken99"}', 'CANARYtoken99'],
      ['Authorization: Basic dXNlcjpDQU5BUll=', 'dXNlcjpDQU5BUll='],
      ['npm_config__auth=CANARYAUTH', 'CANARYAUTH'],
    ];
    for (const [input, canary] of samples) expect(redact(input), input).not.toContain(canary);
    expect(redact('Authorization: Basic dXNlcjpDQU5BUll=')).toContain('Authorization:');
  });
  it('leaves ordinary code and text alone', () => {
    for (const ok of ['const author = "x";', 'see https://example.com/a/b', 'the passport is fine', 'git@github.com:o/r.git']) expect(redact(ok), ok).toBe(ok);
  });
  // Quadratic behaviour on these inputs would take minutes or hours, so a generous wall-clock bound still tells it apart
  // from a loaded machine (which only makes linear code take a few times longer).
  it('stays linear on adversarial input', { timeout: 120_000, retry: 2 }, () => {
    const t = Date.now();
    for (const big of ['a'.repeat(3_000_000), 'token'.repeat(500_000), `${'-----BEGIN PRIVATE KEY-----'.repeat(50_000)}`, `${'http://'.repeat(300_000)}`, '='.repeat(2_000_000)]) redact(big);
    expect(Date.now() - t).toBeLessThan(60_000);
  });
  it('masks keys, bearer tokens, Authorization headers and key=value secrets', () => {
    const s = redact('curl -H "Authorization: Bearer abcdef1234567890" sk-ant-api03-AAAAAAAAAAAA ghp_aaaaaaaaaaaaaaaaaaaa password=hunter22 ok');
    expect(s).not.toMatch(/abcdef1234567890|AAAAAAAAAAAA|ghp_aaaa|hunter22/);
    expect(s).toContain('ok');
  });
  it('redacts nested values without mutating the input', () => {
    const input = { a: ['token=abcdefgh1234'], b: { c: 'fine' } };
    const out = redactDeep(input);
    expect(JSON.stringify(out)).not.toContain('abcdefgh1234');
    expect(input.a[0]).toBe('token=abcdefgh1234');
    expect(out.b.c).toBe('fine');
  });
});
