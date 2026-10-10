// Composition of the per-module Ipc namespaces. Complete: a track extends its own <ns>.ts and mock/<ns>.ts, not this file.
import { createTauriBranches, type BranchesIpc } from "./branches";
import { createTauriFiles, type FilesIpc } from "./files";
import { createTauriGraph, type GraphIpc } from "./graph";
import { createTauriHappy, type HappyIpc } from "./happy";
import { createTauriHud, type HudIpc } from "./hud";
import { createTauriMcp, type McpIpc } from "./mcp";
import { createTauriMongo, type MongoIpc } from "./mongo";
import { createTauriMongoAi, type AiIpc } from "./mongoAi";
import { createMockBranches, type MockBranchHost } from "./mock/branches";
import { createMockFiles } from "./mock/files";
import { createMockGraph } from "./mock/graph";
import { createMockHappy } from "./mock/happy";
import { createMockHud } from "./mock/hud";
import { createMockMcp } from "./mock/mcp";
import { createMockUpdates } from "./mock/updates";
import { createMockNotify } from "./mock/notify";
import { createMockServers } from "./mock/servers";
import { createMockTray } from "./mock/tray";
import { createMockViewers } from "./mock/viewers";
import { createMockMongoWorld } from "./mock/mongo";
import { createMockPreview } from "./mock/preview";
import { createMockRemote } from "./mock/remote";
import { createMockProviders } from "./mock/providers";
import { createMockRoles } from "./mock/roles";
import { createMockRuns } from "./mock/runs";
import { createMockRun } from "./mock/run";
import { createMockSearch } from "./mock/search";
import { createMockSecrets, createMockSettings } from "./mock/settings";
import { createMockTerm } from "./mock/term";
import { createTauriPicker, type PickerIpc } from "./picker";
import { createMockPicker, pickerOptionsFromUrl } from "./mock/picker";
import { createTauriPreview, type PreviewIpc } from "./preview";
import { createTauriProviders, type ProvidersIpc } from "./providers";
import { createTauriRemote, type RemoteIpc } from "./remote";
import { createTauriRoles, type RolesIpc } from "./roles";
import { createTauriRuns, type RunsIpc } from "./runs";
import { createTauriRun, type RunIpc } from "./run";
import { createTauriSearch, type SearchIpc } from "./search";
import { createTauriSecrets, createTauriSettings, type SecretsIpc, type SettingsIpc } from "./settings";
import { createTauriTerm, type TermIpc } from "./term";
import { createTauriNotify, type NotifyIpc } from "./notify";
import { createTauriServers, type ServersIpc } from "./servers";
import { createTauriTray, type TrayIpc } from "./tray";
import { createTauriUpdates, type UpdatesIpc } from "./updates";
import { createTauriViewers, type ViewersIpc } from "./viewers";
import { createTauriWorkspaces, type WorkspacesIpc } from "./workspaces";
import { createMockWorkspaces } from "./mock/workspaces";

export interface IpcNamespaces {
  files: FilesIpc;
  search: SearchIpc;
  branches: BranchesIpc;
  term: TermIpc;
  graph: GraphIpc;
  roles: RolesIpc;
  runs: RunsIpc;
  run: RunIpc;
  settings: SettingsIpc;
  secrets: SecretsIpc;
  providers: ProvidersIpc;
  happy: HappyIpc;
  preview: PreviewIpc;
  remote: RemoteIpc;
  mongo: MongoIpc;
  mongoAi: AiIpc;
  viewers: ViewersIpc;
  hud: HudIpc;
  tray: TrayIpc;
  notify: NotifyIpc;
  servers: ServersIpc;
  updates: UpdatesIpc;
  workspaces: WorkspacesIpc;
  picker: PickerIpc;
  mcp: McpIpc;
}

export function createTauriNamespaces(): IpcNamespaces {
  return {
    files: createTauriFiles(),
    search: createTauriSearch(),
    branches: createTauriBranches(),
    term: createTauriTerm(),
    graph: createTauriGraph(),
    roles: createTauriRoles(),
    runs: createTauriRuns(),
    run: createTauriRun(),
    settings: createTauriSettings(),
    secrets: createTauriSecrets(),
    providers: createTauriProviders(),
    happy: createTauriHappy(),
    preview: createTauriPreview(),
    remote: createTauriRemote(),
    mongo: createTauriMongo(),
    mongoAi: createTauriMongoAi(),
    viewers: createTauriViewers(),
    hud: createTauriHud(),
    tray: createTauriTray(),
    notify: createTauriNotify(),
    servers: createTauriServers(),
    updates: createTauriUpdates(),
    workspaces: createTauriWorkspaces(),
    picker: createTauriPicker(),
    mcp: createTauriMcp(),
  };
}

export function createMockNamespaces(host?: MockBranchHost, workspaces?: WorkspacesIpc): IpcNamespaces {
  const files = createMockFiles();
  const secretKeys = new Set<string>();
  const mongoWorld = createMockMongoWorld();
  const settings = createMockSettings();
  return {
    files: files.api,
    search: createMockSearch(files.tree),
    branches: createMockBranches(host),
    term: createMockTerm(),
    graph: createMockGraph(),
    roles: createMockRoles(),
    runs: createMockRuns(),
    run: createMockRun(),
    settings,
    secrets: createMockSecrets(secretKeys),
    providers: createMockProviders(secretKeys),
    happy: createMockHappy({ secretKeys }),
    preview: createMockPreview(),
    remote: createMockRemote(),
    mongo: mongoWorld.mongo,
    mongoAi: mongoWorld.ai,
    viewers: createMockViewers(),
    hud: createMockHud(),
    tray: createMockTray(),
    notify: createMockNotify(),
    servers: createMockServers(),
    updates: createMockUpdates(),
    workspaces: workspaces ?? createMockWorkspaces(),
    picker: createMockPicker(pickerOptionsFromUrl(globalThis.location?.search ?? "")),
    mcp: createMockMcp(settings),
  };
}
