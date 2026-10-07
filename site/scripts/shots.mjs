// The screenshot slots. Key = file stem, value = what the real screenshot must show.
// Real files go in src/static/assets/img/shots/ as <name>-<light|dark>-<2880|1440|720>.<png|webp|avif>.
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
  providers: 'Settings > Providers: provider cards and the Experimental providers switch',
  'api-contract': 'API contract view: contract-drift findings',
  'api-explorer': 'API contract view: read-only Swagger explorer',
};

export const WIDTHS = [720, 1440, 2880];
