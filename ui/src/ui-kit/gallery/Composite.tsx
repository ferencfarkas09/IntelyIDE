import { createMemo, createSignal, For, Show } from "solid-js";
import {
  AheadBehind, Badge, BranchPill, Checkbox, ChevronsDownUp, ChevronsUpDown, Download, Eye, File, FolderGit2, GitCommitHorizontal, GitGraph,
  Icon, IconButton, LocateFixed, Lock, Pill, RefreshCw, RepoBadge, ScrollArea, Search, SegmentedControl, Settings, Spinner, SplitButton, Splitter, StatusDot, StatusLetter,
  TextArea, TitleBar, Tree, TreeRow, Undo2, Upload, Archive, Button, Tooltip, deriveCheckState, type ChangeKindName,
} from "..";

interface FileRow { path: string; kind: ChangeKindName; locked?: boolean }
interface Repo { id: string; name: string; color: string; badge: string; branch: string; ahead: number; behind: number; files: FileRow[]; untracked: number }

const REPOS: Repo[] = [
  {
    id: "hb", name: "shop-backend", color: "#4caf7d", badge: "HB", branch: "sandbox", ahead: 1, behind: 0, untracked: 0,
    files: [
      { path: "src/api/routes/orders.js", kind: "modified" },
      { path: "src/api/services/tipService.js", kind: "added" },
      { path: "src/api/constants/oldRates.js", kind: "deleted" },
      { path: "src/lib/éttermi/árlista.js", kind: "renamed" },
    ],
  },
  {
    id: "ad", name: "admin", color: "#8b6cf0", badge: "AD", branch: "feature-light-design", ahead: 1, behind: 2, untracked: 26,
    files: [
      { path: "src/components/modules/whatsNew/index.tsx", kind: "modified" },
      { path: ".env.local", kind: "untracked", locked: true },
    ],
  },
  { id: "sv", name: "shop-mobile", color: "#f0a23a", badge: "SV", branch: "main", ahead: 0, behind: 0, untracked: 0, files: [{ path: "app/screens/Login.tsx", kind: "conflicted" }] },
];

function leaf(p: string) { return p.slice(p.lastIndexOf("/") + 1); }
function dir(p: string) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }

function CommitPanel() {
  const [checked, setChecked] = createSignal<Record<string, boolean>>(Object.fromEntries(REPOS.flatMap((r) => r.files.filter((f) => !f.locked).map((f) => [r.id + f.path, true]))));
  const [open, setOpen] = createSignal<Record<string, boolean>>({ hb: true, ad: true, sv: false });
  const [selected, setSelected] = createSignal("hbsrc/api/routes/orders.js");
  const [message, setMessage] = createSignal("Fix tip rounding for Á-la-carte orders");
  const [amend, setAmend] = createSignal(false);
  const fileState = (r: Repo) => deriveCheckState(r.files.filter((f) => checked()[r.id + f.path]).length, r.files.filter((f) => !f.locked).length);
  const total = createMemo(() => Object.values(checked()).filter(Boolean).length);
  const setRepo = (r: Repo, on: boolean) => setChecked((c) => ({ ...c, ...Object.fromEntries(r.files.filter((f) => !f.locked).map((f) => [r.id + f.path, on])) }));
  const repoCount = createMemo(() => REPOS.filter((r) => fileState(r) !== false).length);

  return (
    <div class="kit-commit">
      <div class="kit-commit__toolbar">
        <IconButton icon={RefreshCw} label="Refresh" size="sm" shortcut={["⌘", "R"]} />
        <IconButton icon={Undo2} label="Rollback" tooltip="Rollback (soon)" size="sm" disabled />
        <IconButton icon={Download} label="Update (pull)" size="sm" />
        <IconButton icon={Eye} label="Diff preview" size="sm" pressed />
        <IconButton icon={LocateFixed} label="Locate in tree" size="sm" />
        <span class="kit-grow" />
        <IconButton icon={ChevronsUpDown} label="Expand all" size="sm" />
        <IconButton icon={ChevronsDownUp} label="Collapse all" size="sm" />
      </div>
      <div class="kit-commit__tabs">
        <SegmentedControl size="sm" aria-label="Commit view" value="commit" onChange={() => {}} options={[{ value: "commit", label: "Commit" }, { value: "stash", label: "Stash", icon: Archive, disabled: true, tooltip: "Available in a later phase" }]} />
      </div>
      <ScrollArea class="kit-commit__tree">
        <Tree aria-label="Changes" multiselectable>
          <For each={REPOS}>
            {(r) => (
              <>
                <TreeRow
                  compact
                  depth={0}
                  expanded={open()[r.id]}
                  onToggle={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
                  leading={<><Checkbox size="sm" aria-label={`Select all in ${r.name}`} checked={fileState(r)} onChange={(v) => setRepo(r, v)} /><RepoBadge color={r.color} badge={r.badge} size={16} /></>}
                  trailing={<><Badge size="sm" numeric>{r.files.length + r.untracked}</Badge><BranchPill name={r.branch} /><AheadBehind ahead={r.ahead} behind={r.behind} /></>}
                  actions={<>
                    <IconButton icon={GitCommitHorizontal} label="Commit this repo" size="sm" iconSize={14} />
                    <IconButton icon={Upload} label="Push" size="sm" iconSize={14} />
                    <IconButton icon={Download} label="Pull" size="sm" iconSize={14} />
                  </>}
                >
                  <span class="kit-repo-name">{r.name}</span>
                </TreeRow>
                <Show when={open()[r.id]}>
                  <For each={r.files}>
                    {(f) => (
                      <TreeRow
                        compact depth={1} disabled={f.locked}
                        selected={selected() === r.id + f.path}
                        onClick={() => setSelected(r.id + f.path)}
                        leading={<>
                          <Checkbox size="sm" aria-label={`Include ${leaf(f.path)}`} disabled={f.locked} checked={!!checked()[r.id + f.path]} onChange={(v) => setChecked((c) => ({ ...c, [r.id + f.path]: v }))} />
                          <StatusLetter kind={f.kind} />
                        </>}
                        trailing={f.locked ? <Tooltip label="Secret file: never committed"><Icon icon={Lock} size={12} label="Guarded" /></Tooltip> : undefined}
                      >
                        <span classList={{ "ui-file-deleted": f.kind === "deleted" }}>{leaf(f.path)}</span>
                        <Show when={dir(f.path)}><span class="ui-path-hint">{dir(f.path)}</span></Show>
                      </TreeRow>
                    )}
                  </For>
                  <Show when={r.untracked > 0}>
                    <TreeRow compact depth={1} expanded={false} leading={<Checkbox size="sm" aria-label="Select unversioned files" checked={false} />} trailing={<Badge size="sm" numeric>{r.untracked}</Badge>}>
                      <span class="ui-text-2">Unversioned files</span>
                    </TreeRow>
                  </Show>
                </Show>
              </>
            )}
          </For>
        </Tree>
      </ScrollArea>
      <div class="kit-commit__compose">
        <TextArea aria-label="Commit message" placeholder="Commit message" minRows={3} maxRows={6} value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
        <div class="kit-commit__row">
          <Checkbox size="sm" label="Amend" checked={amend()} onChange={setAmend} />
          <span class="kit-grow" />
          <span class="ui-text-3 ui-tnum" style={{ "font-size": "var(--text-xs)" }}>{message().length}/72</span>
        </div>
        <div class="kit-commit__actions">
          <SplitButton
            variant="primary" icon={GitCommitHorizontal} onClick={() => {}} disabled={total() === 0}
            items={[
              { label: "Commit and Push…", icon: Upload, shortcut: ["⌥", "⌘", "⏎"], onSelect: () => {} },
              { type: "separator" },
              { label: "Commit without hooks", danger: true, onSelect: () => {} },
            ]}
          >
            {`Commit (${repoCount()} repos, ${total()} files)`}
          </SplitButton>
        </div>
      </div>
    </div>
  );
}

function DiffMock() {
  const lines: [string, string, string][] = [
    ["", " ", "function roundTip(amount, rate) {"],
    ["", " ", "  // Borravaló kerekítése: árvíztűrő tükörfúrógép"],
    ["del", "-", "  return Math.round(amount * rate);"],
    ["add", "+", "  const tip = amount * rate;"],
    ["add", "+", "  return Math.round(tip / 5) * 5; // 5 Ft-os kerekítés"],
    ["", " ", "}"],
    ["", " ", ""],
    ["", " ", "export function applyTip(order) {"],
    ["del", "-", "  order.total += roundTip(order.total, 0.1);"],
    ["add", "+", "  order.tip = roundTip(order.subtotal, order.tipRate ?? 0.1);"],
    ["add", "+", "  order.total = order.subtotal + order.tip;"],
    ["", " ", "  return order;"],
    ["", " ", "}"],
  ];
  return (
    <div class="kit-diff">
      <div class="kit-diff__head">
        <StatusLetter kind="modified" />
        <span class="kit-diff__name">orders.js</span>
        <span class="ui-path-hint" style={{ "margin-left": 0 }}>src/api/routes</span>
        <span class="kit-grow" />
        <Badge tone="ok" size="sm" numeric>+3</Badge>
        <Badge tone="danger" size="sm" numeric>−2</Badge>
      </div>
      <ScrollArea class="kit-diff__body" orientation="both">
        <pre class="kit-diff__code ui-mono ui-selectable">
          <For each={lines}>
            {([kind, sign, text], i) => (
              <div class="kit-diff__line" data-kind={kind || undefined}>
                <span class="kit-diff__no ui-tnum">{i() + 12}</span>
                <span class="kit-diff__sign">{sign}</span>
                <span>{text}</span>
              </div>
            )}
          </For>
        </pre>
      </ScrollArea>
    </div>
  );
}

export function Composite() {
  const [mode, setMode] = createSignal<"agent" | "editor">("editor");
  const [rail, setRail] = createSignal("commit");
  return (
    <div class="kit-window">
      <TitleBar
        left={
          <SegmentedControl
            size="sm" aria-label="Mode" value={mode()} onChange={setMode}
            options={[{ value: "agent", label: "Agent", disabled: true, tooltip: "Agent mode (soon)" }, { value: "editor", label: "Editor" }]}
          />
        }
        center={
          <div class="kit-title-center">
            <span class="kit-workspace"><Icon icon={FolderGit2} size={14} /> Happy workspace</span>
            <For each={REPOS}>
              {(r) => (
                <Pill size="sm" onClick={() => {}} aria-label={`${r.name} on ${r.branch}`} leading={<RepoBadge color={r.color} badge={r.badge} size={16} />} trailing={<AheadBehind ahead={r.ahead} behind={r.behind} />}>
                  {r.branch}
                </Pill>
              )}
            </For>
          </div>
        }
        right={<IconButton icon={Settings} label="Settings" shortcut={["⌘", ","]} size="sm" />}
      />
      <div class="kit-window__body">
        <nav class="kit-rail" aria-label="Tool windows">
          <IconButton icon={File} label="Project" size="md" pressed={rail() === "project"} onClick={() => setRail("project")} tooltipPlacement="right" />
          <IconButton icon={GitCommitHorizontal} label="Commit" shortcut={["⌘", "0"]} size="md" pressed={rail() === "commit"} onClick={() => setRail("commit")} tooltipPlacement="right" />
          <IconButton icon={GitGraph} label="Graph" tooltip="Graph (soon)" size="md" disabled tooltipPlacement="right" />
          <IconButton icon={Search} label="Search" tooltip="Search (soon)" size="md" disabled tooltipPlacement="right" />
        </nav>
        <Splitter class="kit-window__split" first={<CommitPanel />} second={<DiffMock />} defaultSize={360} min={280} max={520} minOther={240} storageKey="gallery.composite" label="Resize commit panel" />
      </div>
      <footer class="kit-status">
        <span class="kit-status__item"><StatusDot tone="ok" size={6} label="Ready" /> git 2.50 ready</span>
        <span class="kit-status__item"><Spinner size={12} /> Pushing admin… 62%</span>
        <span class="kit-grow" />
        <span class="kit-status__item ui-tnum">Mem 74 MB</span>
      </footer>
    </div>
  );
}
