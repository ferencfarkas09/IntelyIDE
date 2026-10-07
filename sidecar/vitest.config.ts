import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{ name: 'jsonl-text', transform: (code, id) => (id.endsWith('.jsonl') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null) }],
  test: { include: ['test/**/*.test.ts'], testTimeout: 20_000 },
});
