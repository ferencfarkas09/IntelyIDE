// The only place adapter modules are named. Dynamic imports keep each adapter (and the Agent SDK behind it) out of memory
// until a session of that provider opens; esbuild turns them into lazy initializers inside the single-file bundle.
import type { Registry } from './loader.js';

export const registry: Registry = {
  claude: () => import('./adapters/claude-sdk/index.js'),
  mock: () => import('./adapters/mock/index.js'),
  acp: () => import('./adapters/acp/index.js'),
  gemini: () => import('./adapters/acp/gemini.js'),
  copilot: () => import('./adapters/acp/copilot.js'),
  opencode: () => import('./adapters/acp/opencode.js'),
  goose: () => import('./adapters/acp/goose.js'),
  qwen: () => import('./adapters/acp/qwen.js'),
  codex: () => import('./adapters/codex/index.js'),
};
