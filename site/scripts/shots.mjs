// The screenshot slots. Key = file stem, value = what the real screenshot must show.
// Real files go in src/static/assets/img/shots/ as <name>-<light|dark>-<width>.<png|webp|avif>.
// IntelyIDE: 720 / 1440 (from 1600 px sources, never upscaled). IntelyOpti: 720 / 1440 / 2400.
export const SHOTS = {
  hero: 'Main window: Changes tree, editor and an agent panel (demo workspace)',
  'changes-tree': 'Changes tree with four repositories and grouped changes',
  'push-dialog': 'Push dialog with one checkbox per repository',
  'agent-approval': 'Agent safety card: an approval waiting in the needs-you inbox',
  rewind: 'Rewind: the snapshot taken at the start of an agent run',
  'workspaces-welcome': 'Welcome screen with recent workspaces and the workspace switcher',
  preview: 'Run panel with live dev-server preview and click-to-source',
  remote: 'Remote: phone companion watching an agent run',
  'mongo-studio': 'MongoDB Studio, read-only, with an AI-generated query',
  team: 'Team (Beta): a teammate\'s shared run, read-only, with a note waiting for approval',
  'team-memory': 'Team (Beta): shared Claude memory with a pending CLAUDE.md change and a conflict copy',
  'team-chat': 'Team (Beta): the chat in a teammate\'s shared run',
  'team-commits': 'Team (Beta): the commits and edits of the whole team, with a team timeline',
  providers: 'Settings > Providers: provider cards and the Experimental providers switch',
  integrations: 'Settings > Integrations: the catalog with Happy, MCP servers, Sentry and DeepPattern',
  'mcp-catalog': 'Settings > MCP servers: the catalog of ready-made servers, each with its exact program line',
  versions: 'Versions panel: the version files of every repository, with Patch, Minor, Major and Build +1 for one repository or all, and a change pending',
  'versions-diff': 'Versions panel: the exact diff of every file that would change, shown under "Will change" before Apply',
  intelyfix: 'IntelyFIX: the Sentry issues with their chips, and one issue open with Fix, assign and resolve',
  'api-contract': 'API contract view: contract-drift findings',
  appearance: 'Settings > Appearance: themes and accent colors',
  palette: 'Command palette',
  'diff-graph': 'Diff and commit graph',
};

// IntelyOpti captures: opti-<name>-<light|dark>.png, 2400x1600, dropped by the owner into IntelyOpti/site-assets/shots/.
export const OPTI_SHOTS = {
  'opti-dashboard': 'Smart Care dashboard: health score and one-click optimize',
  'opti-health': 'Mac Health: thermals, fans, battery, SSD',
  'opti-turbo': 'Turbo: background-service diet, priorities, GPU mode',
  'opti-tweaks': 'Speed Tweaks: reversible animation and effect tweaks',
  'opti-network': 'Network Speed: download, upload, responsiveness, DNS benchmark',
  'opti-modes': 'Pro Modes: Max Speed, Cool Down, Focus, Battery Saver',
  'opti-advisor': 'AI Advisor: plan built from a redacted snapshot',
  'opti-cleanup': 'Cleanup: caches, logs, developer leftovers',
};

/** Widths available per slot family, smallest first. Pages tolerate any subset. */
export const WIDTHS = [720, 1440, 2880];
export const OPTI_WIDTHS = [720, 1440, 2400];
/** Intrinsic size (w, h) the <img> declares at the 1440 variant, to avoid layout shift. */
export const DEFAULT_DIMS = [1440, 923];
export const DIMS = {
  integrations: [1440, 900], 'mcp-catalog': [1440, 900], versions: [1440, 900], 'versions-diff': [1440, 900], intelyfix: [1440, 900], team: [1440, 900], 'team-memory': [1440, 900], 'team-chat': [1440, 900], 'team-commits': [1440, 900], 'api-explorer': [1440, 900],
};
export const OPTI_DIMS = [1440, 960];
