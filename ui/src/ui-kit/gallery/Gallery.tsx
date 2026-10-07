import { createSignal, For, type JSX } from "solid-js";
import {
  Announcer, Badge, BrandMark, BranchPill, Button, Checkbox, Copy, Dialog, EmptyState, Eye, GitBranch, IconButton, Inbox, Input, Kbd, Keyboard, Menu, Moon, Monitor, Pencil, Plus, Popover,
  ProgressBar, REPO_PALETTE, RefreshCw, RepoBadge, ScrollArea, Search, SegmentedControl, ShieldAlert, Skeleton, Spinner, SplitButton, Splitter, StatusDot, StatusLetter, Sun,
  TextArea, Toaster, Tooltip, Tree, TreeRow, Trash2, TriangleAlert, Upload, createToaster, deriveCheckState, initTheme, setThemePreference, themePreference, AheadBehind, Pill, Switch, Download, Icon,
  type ChangeKindName, type ThemePreference,
} from "..";
import { Composite } from "./Composite";
import "./gallery.css";

function Section(props: { id: string; title: string; hint?: string; wide?: boolean; children: JSX.Element }) {
  return (
    <section class="kit-section" id={props.id} data-wide={props.wide ? "" : undefined}>
      <h3 class="kit-section__title">{props.title}</h3>
      {props.hint && <p class="kit-section__hint">{props.hint}</p>}
      <div class="kit-section__body">{props.children}</div>
    </section>
  );
}
const Row = (props: { label?: string; children: JSX.Element }) => (
  <div class="kit-row">
    {props.label && <span class="kit-row__label">{props.label}</span>}
    <div class="kit-row__items">{props.children}</div>
  </div>
);

function Buttons() {
  const [loading, setLoading] = createSignal(false);
  const run = () => { setLoading(true); setTimeout(() => setLoading(false), 1800); };
  return (
    <>
      <Row label="Variants">
        <Button variant="primary">Commit</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="ghost">Skip</Button>
        <Button variant="danger">Force push</Button>
      </Row>
      <Row label="Sizes">
        <Button variant="primary" size="sm">Small</Button>
        <Button variant="primary" size="md">Medium</Button>
        <Button variant="primary" size="lg">Large</Button>
        <Button variant="secondary" size="sm" icon={Plus}>Add</Button>
        <Button variant="secondary" icon={RefreshCw}>Refresh</Button>
      </Row>
      <Row label="States">
        <Button variant="primary" disabled>Disabled</Button>
        <Button variant="secondary" disabled>Disabled</Button>
        <Button variant="primary" loading={loading()} onClick={run}>{loading() ? "Committing" : "Click to load"}</Button>
        <Button variant="secondary" loading>Loading</Button>
        <Button variant="danger" loading>Loading</Button>
      </Row>
      <Row label="Icon buttons">
        <IconButton icon={RefreshCw} label="Refresh" shortcut={["⌘", "R"]} />
        <IconButton icon={Eye} label="Preview" pressed />
        <IconButton icon={Copy} label="Copy" variant="secondary" />
        <IconButton icon={Trash2} label="Delete (soon)" disabled />
        <IconButton icon={RefreshCw} label="Refreshing" loading />
        <IconButton icon={Plus} label="Add" size="sm" />
        <IconButton icon={Plus} label="Add" size="lg" variant="secondary" />
      </Row>
      <Row label="Split button">
        <SplitButton onClick={() => {}} items={[{ label: "Commit and Push…", icon: Upload, shortcut: ["⌥", "⌘", "⏎"], onSelect: () => {} }, { type: "separator" }, { label: "Commit without hooks", danger: true, onSelect: () => {} }]}>Commit</SplitButton>
        <SplitButton variant="secondary" size="sm" onClick={() => {}} items={[{ label: "Force push (with lease)…", danger: true, onSelect: () => {} }]}>Push</SplitButton>
      </Row>
    </>
  );
}

function Selection() {
  const [kids, setKids] = createSignal([true, false, true]);
  const parent = () => deriveCheckState(kids().filter(Boolean).length, kids().length);
  const [sw, setSw] = createSignal(true);
  const [seg, setSeg] = createSignal<ThemePreference>("dark");
  const [one, setOne] = createSignal(true);
  return (
    <>
      <Row label="Checkbox">
        <Checkbox checked={false} aria-label="off" />
        <Checkbox checked={true} aria-label="on" />
        <Checkbox checked="mixed" aria-label="mixed" />
        <Checkbox checked={false} disabled aria-label="disabled off" />
        <Checkbox checked={true} disabled aria-label="disabled on" />
        <Checkbox size="sm" checked="mixed" aria-label="small mixed" />
        <Checkbox checked={one()} onChange={setOne} label="With label" />
      </Row>
      <Row label="Tri-state parent">
        <div class="kit-tri">
          <Checkbox checked={parent()} onChange={(v) => setKids([v, v, v])} label="backend" />
          <div class="kit-tri__kids">
            <For each={["routes/orders.js", "services/tip.js", "README.md"]}>
              {(n, i) => <Checkbox checked={kids()[i()]} onChange={(v) => setKids((k) => k.map((x, j) => (j === i() ? v : x)))} label={n} />}
            </For>
          </div>
        </div>
      </Row>
      <Row label="Switch">
        <Switch checked={sw()} onChange={setSw} label="Run Git hooks" />
        <Switch checked={!sw()} onChange={(v) => setSw(!v)} size="sm" label="Small" />
        <Switch checked={false} disabled label="Disabled" />
      </Row>
      <Row label="Segmented">
        <SegmentedControl aria-label="Theme" value={seg()} onChange={setSeg} options={[{ value: "system", label: "System", icon: Monitor }, { value: "dark", label: "Dark", icon: Moon }, { value: "light", label: "Light", icon: Sun }]} />
        <SegmentedControl size="sm" aria-label="Push tags" value="follow" onChange={() => {}} options={[{ value: "none", label: "None" }, { value: "follow", label: "Current branch" }, { value: "all", label: "All" }]} />
      </Row>
    </>
  );
}

function Fields() {
  const [text, setText] = createSignal("Árvíztűrő tükörfúrógép\nFix: ő, ű, á, é, í, ó, ö, ú, ü");
  return (
    <>
      <Row label="Input">
        <Input placeholder="Search changes" leading={<Icon icon={Search} size={14} />} wrapperClass="kit-w-220" />
        <Input value="origin" aria-label="Remote" wrapperClass="kit-w-120" />
        <Input size="sm" placeholder="Small" wrapperClass="kit-w-120" />
        <Input size="lg" placeholder="Large" wrapperClass="kit-w-120" />
      </Row>
      <Row label="States">
        <Input value="feature/ég" invalid aria-label="Branch" wrapperClass="kit-w-220" trailing={<Icon icon={TriangleAlert} size={14} />} />
        <Input value="Disabled" disabled aria-label="Disabled" wrapperClass="kit-w-120" />
      </Row>
      <Row label="TextArea (auto-grow)">
        <TextArea aria-label="Message" minRows={2} maxRows={6} value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder="Commit message" wrapperClass="kit-w-full" />
      </Row>
    </>
  );
}

function Badges() {
  return (
    <>
      <Row label="Badge">
        <Badge>Neutral</Badge><Badge tone="accent">Accent</Badge><Badge tone="ok">Added</Badge><Badge tone="warn">Warning</Badge><Badge tone="danger">Failed</Badge><Badge tone="info">Info</Badge>
      </Row>
      <Row label="Solid / outline">
        <Badge variant="solid" tone="accent">New</Badge><Badge variant="solid" tone="ok">ok</Badge><Badge variant="solid" tone="danger">3</Badge><Badge variant="solid">12</Badge>
        <Badge variant="outline">Outline</Badge><Badge variant="outline" tone="warn">Protected</Badge><Badge variant="outline" tone="accent" icon={GitBranch}>main</Badge>
      </Row>
      <Row label="Repo badges">
        <For each={REPO_PALETTE}>{(c, i) => <RepoBadge color={c} badge={["HB", "AD", "SV", "HP", "RX", "TQ", "CO", "LM"][i()]} size={24} />}</For>
      </Row>
      <Row label="Sizes">
        <RepoBadge color="#4caf7d" badge="HB" size={16} /><RepoBadge color="#8b6cf0" badge="AD" size={20} /><RepoBadge color="#3b9ae8" badge="HP" size={24} />
      </Row>
      <Row label="Branch / ahead-behind">
        <BranchPill name="feature-light-design" /><BranchPill name="SHOP-260" /><BranchPill detached oid="a1b2c3d" /><BranchPill unborn />
        <AheadBehind ahead={1} behind={0} /><AheadBehind ahead={3} behind={12} /><AheadBehind ahead={0} behind={2} />
      </Row>
      <Row label="Pills">
        <Pill size="sm" onClick={() => {}} leading={<RepoBadge color="#4caf7d" badge="HB" size={16} />} trailing={<AheadBehind ahead={1} behind={0} />}>sandbox</Pill>
        <Pill onClick={() => {}} selected leading={<RepoBadge color="#8b6cf0" badge="AD" size={16} />}>admin</Pill>
        <Pill tone="ok" leading={<StatusDot tone="ok" size={6} />}>Synced</Pill>
        <Pill tone="warn" leading={<StatusDot tone="warn" size={6} />}>Merging</Pill>
        <Pill tone="danger" leading={<StatusDot tone="danger" size={6} />}>Conflicts</Pill>
      </Row>
      <Row label="Status dots">
        <StatusDot /><StatusDot tone="ok" /><StatusDot tone="warn" /><StatusDot tone="danger" /><StatusDot tone="info" /><StatusDot tone="accent" pulse />
      </Row>
      <Row label="Change status">
        <For each={["modified", "added", "deleted", "renamed", "untracked", "conflicted"] as ChangeKindName[]}>{(k) => <span class="kit-status-demo"><StatusLetter kind={k} /><span classList={{ "ui-file-deleted": k === "deleted" }}>{k}</span></span>}</For>
      </Row>
      <Row label="Kbd">
        <Kbd keys={["⌘", "⏎"]} /><Kbd keys={["⌥", "⌘", "⏎"]} /><Kbd keys={["⌘", "⇧", "K"]} /><Kbd>Esc</Kbd><Kbd>Space</Kbd>
      </Row>
    </>
  );
}

const toaster = createToaster();
function Feedback(props: { side: "left" | "right" }) {
  const [p, setP] = createSignal(42);
  setInterval(() => setP((v) => (v >= 100 ? 0 : v + 1)), 90);
  return (
    <>
      <Row label="Spinner">
        <Spinner size={12} /><Spinner size={14} /><Spinner size={16} /><Spinner size={20} /><Spinner size={24} />
      </Row>
      <Row label="Progress">
        <div class="kit-w-full kit-stack">
          <ProgressBar aria-label="Pushing" value={p()} />
          <ProgressBar aria-label="Done" value={100} tone="ok" size="sm" />
          <ProgressBar aria-label="Waiting" />
        </div>
      </Row>
      <Row label="Skeleton">
        <div class="kit-w-full kit-skel">
          <div class="kit-skel__row"><Skeleton variant="circle" width={16} height={16} /><Skeleton variant="text" width="38%" /><Skeleton variant="text" width="16%" /></div>
          <div class="kit-skel__row"><Skeleton variant="circle" width={16} height={16} /><Skeleton variant="text" width="52%" /><Skeleton variant="text" width="10%" /></div>
          <div class="kit-skel__row"><Skeleton variant="circle" width={16} height={16} /><Skeleton variant="text" width="30%" /><Skeleton variant="text" width="22%" /></div>
        </div>
      </Row>
      <Row label="Empty / error">
        <div class="kit-empty-pair">
          <EmptyState size="sm" icon={Inbox} title="Nothing to commit" description="Your working trees are clean." action={<Button size="sm" icon={RefreshCw}>Refresh</Button>} />
          <EmptyState size="sm" tone="danger" icon={ShieldAlert} title="Could not read admin" description="The repository is missing or not a Git work tree." action={<Button size="sm" variant="secondary">Locate…</Button>} />
        </div>
      </Row>
      <Row label="Toasts">
        <Button size="sm" onClick={() => toaster.success("Pushed 2 commits", "backend/sandbox → origin/sandbox")}>Success</Button>
        <Button size="sm" onClick={() => toaster.error("Hook rejected the commit", "lint-staged failed in shop-backend.")}>Error</Button>
        <Button size="sm" onClick={() => toaster.show({ title: "Committed locally, not pushed", tone: "warn", action: { label: "Push…", onSelect: () => {} } })}>Action</Button>
        <Button size="sm" variant="ghost" onClick={() => toaster.info("Fetched 4 repos")}>Info</Button>
      </Row>
      <Toaster toaster={toaster} placement={props.side === "left" ? "bottom-left" : "bottom-right"} />
    </>
  );
}

function Overlays() {
  const [dlg, setDlg] = createSignal(false);
  const [confirm, setConfirm] = createSignal(false);
  const [picked, setPicked] = createSignal(["admin", "backend"]);
  const toggle = (n: string, v: boolean) => setPicked((l) => (v ? [...l, n] : l.filter((x) => x !== n)));
  return (
    <>
      <Row label="Tooltip">
        <Tooltip label="Refresh" shortcut={["⌘", "R"]}><Button variant="secondary" size="sm" icon={RefreshCw}>Hover me</Button></Tooltip>
        <Tooltip label="Commit and Push…" shortcut={["⌥", "⌘", "⏎"]} placement="bottom"><Button variant="secondary" size="sm">Below</Button></Tooltip>
        <Tooltip label="Agent mode arrives in a later phase"><Button variant="secondary" size="sm" disabled>Disabled</Button></Tooltip>
      </Row>
      <Row label="Menu / popover">
        <Menu
          aria-label="Repository actions"
          trigger={(t) => <Button {...t} variant="secondary" iconRight={undefined}>Actions</Button>}
          items={[
            { type: "label", label: "Repository" },
            { label: "Fetch", icon: Download, shortcut: ["⌘", "F"], onSelect: () => {} },
            { label: "Pull (fast-forward)", icon: Download, onSelect: () => {} },
            { label: "Rename branch…", icon: Pencil, description: "Local only", onSelect: () => {} },
            { type: "separator" },
            { label: "Show hidden files", checked: true, onSelect: () => {} },
            { label: "Discard changes…", icon: Trash2, danger: true, onSelect: () => {} },
            { label: "Unavailable", disabled: true, onSelect: () => {} },
          ]}
        />
        <Popover trigger={(t) => <Button {...t} variant="secondary" size="md">Push target</Button>} aria-label="Push target">
          <div class="kit-pop">
            <div class="kit-pop__title">Push target</div>
            <Input size="sm" value="origin" aria-label="Remote" />
            <Input size="sm" value="feature-light-design" aria-label="Branch" />
            <Button size="sm" variant="primary">Save</Button>
          </div>
        </Popover>
      </Row>
      <Row label="Dialog">
        <Button variant="secondary" onClick={() => setDlg(true)}>Push…</Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>Force push…</Button>
      </Row>
      <Dialog
        open={dlg()} onClose={() => setDlg(false)} title="Push commits" size="md" description="Choose which repositories to push."
        footer={<><Button variant="ghost" onClick={() => setDlg(false)}>Cancel</Button><Button variant="primary" icon={Upload} onClick={() => setDlg(false)}>Push</Button></>}
      >
        <div class="kit-dlg-list">
          <For each={[["backend", "sandbox → origin : sandbox", "#4caf7d", "HB"], ["admin", "feature-light-design → origin : feature-light-design", "#8b6cf0", "AD"], ["services-app", "main (nothing to push)", "#f0a23a", "SV"]]}>
            {([n, d, c, b]) => (
              <label class="kit-dlg-row" data-muted={n === "services-app" ? "" : undefined}>
                <Checkbox checked={picked().includes(n)} disabled={n === "services-app"} onChange={(v) => toggle(n, v)} aria-label={n} />
                <RepoBadge color={c} badge={b} />
                <span class="kit-dlg-row__name">{n}</span>
                <span class="ui-mono ui-text-3 ui-truncate" style={{ "font-size": "11.5px" }}>{d}</span>
              </label>
            )}
          </For>
        </div>
        <Switch checked label="Run Git hooks" />
      </Dialog>
      <Dialog
        open={confirm()} onClose={() => setConfirm(false)} role="alertdialog" size="sm" title="Force push with lease?"
        description="This overwrites 2 commits on origin/feature-light-design. Type the branch name to confirm."
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" onClick={() => setConfirm(false)}>Force push</Button></>}
      >
        <Input data-autofocus placeholder="feature-light-design" aria-label="Branch name" />
      </Dialog>
    </>
  );
}

function TreeAndSplit(props: { theme: string }) {
  const [sel, setSel] = createSignal("b");
  const [open, setOpen] = createSignal(true);
  return (
    <>
      <Row label="Tree rows">
        <div class="kit-tree-demo">
          <Tree aria-label="Demo tree">
            <TreeRow expanded={open()} onToggle={() => setOpen(!open())} leading={<Icon icon={GitBranch} size={14} />} trailing={<Badge size="sm" numeric>4</Badge>}>src</TreeRow>
            {open() && (
              <>
                <TreeRow depth={1} expanded selected={sel() === "a"} onClick={() => setSel("a")}>components</TreeRow>
                <TreeRow depth={2} selected={sel() === "b"} onClick={() => setSel("b")} leading={<StatusLetter kind="modified" />} actions={<IconButton icon={Eye} label="Preview" size="sm" />}>CommitPanel.tsx</TreeRow>
                <TreeRow depth={2} selected={sel() === "c"} onClick={() => setSel("c")} leading={<StatusLetter kind="added" />}>PushDialog.tsx</TreeRow>
                <TreeRow depth={1} disabled leading={<StatusLetter kind="untracked" />}>.env.local</TreeRow>
              </>
            )}
            <TreeRow compact expanded={false}>Compact row (22 px)</TreeRow>
          </Tree>
        </div>
      </Row>
      <Row label="Splitter (drag, arrow keys, double-click)">
        <div class="kit-split-demo">
          <Splitter first={<div class="kit-pane">Left<br /><span class="ui-text-3">persisted</span></div>} second={<div class="kit-pane">Right</div>} defaultSize={140} min={80} max={320} minOther={120} storageKey={`gallery.demo.${props.theme}`} />
        </div>
      </Row>
    </>
  );
}

const SURFACES = ["surface-0", "surface-1", "surface-2", "surface-3", "surface-4"];
const TEXTS = ["text-1", "text-2", "text-3", "text-4"];
const SEM = ["accent", "ok", "warn", "danger", "info"];

function Foundations() {
  return (
    <>
      <Row label="Surfaces">
        <div class="kit-swatches"><For each={SURFACES}>{(s) => <div class="kit-sw"><span class="kit-sw__chip" style={{ background: `var(--${s})` }} /><span>{s}</span></div>}</For></div>
      </Row>
      <Row label="Text levels">
        <div class="kit-text-levels"><For each={TEXTS}>{(t, i) => <span style={{ color: `var(--${t})` }}>{["Primary", "Secondary", "Tertiary", "Disabled"][i()]} {t}</span>}</For></div>
      </Row>
      <Row label="Semantic">
        <div class="kit-swatches"><For each={SEM}>{(s) => <div class="kit-sw"><span class="kit-sw__chip" style={{ background: `var(--${s}-subtle, var(--accent-subtle))`, "box-shadow": `inset 0 0 0 1px var(--${s}-border, var(--accent-border))` }}><span class="kit-sw__dot" style={{ background: s === "accent" ? "var(--accent-text)" : `var(--${s})` }} /></span><span>{s}</span></div>}</For></div>
      </Row>
      <Row label="Repo palette">
        <div class="kit-swatches"><For each={[1, 2, 3, 4, 5, 6, 7, 8]}>{(n) => <div class="kit-sw"><span class="kit-sw__chip" style={{ background: `var(--repo-${n})` }} /><span>{n}</span></div>}</For></div>
      </Row>
      <Row label="Inter Variable">
        <div class="kit-type">
          <div style={{ "font-size": "var(--text-xl)", "font-weight": 600, "letter-spacing": "-0.02em" }}>Árvíztűrő tükörfúrógép</div>
          <div style={{ "font-size": "var(--text-md)", "font-weight": 600 }}>ÁÉÍÓÖŐÚÜŰ áéíóöőúüű 0123456789</div>
          <div>Commit (3 repos, 12 files) · Push to origin/sandbox · ő ű ö ü</div>
          <div class="ui-text-2" style={{ "font-size": "var(--text-sm)" }}>Secondary text, 12 px: Nincs mit commitolni, a munkafák tiszták.</div>
          <div class="ui-tnum ui-text-2">Tabular: 1 111 · 8 888 · 11 111 (counts line up)</div>
        </div>
      </Row>
      <Row label="JetBrains Mono Variable">
        <pre class="ui-mono kit-mono">{`const élő = "árvíztűrő tükörfúrógép";\nfunction tőzsde(ár: number): string { return \`\${ár} Ft\`; }\n// ÁÉÍÓÖŐÚÜŰ áéíóöőúüű  =>  ->  !==  0O  1lI`}</pre>
      </Row>
    </>
  );
}

function Brand() {
  return (
    <>
      <Row label="Mark">
        <BrandMark variant="mark" size={96} label="Mark, 96 px" />
        <BrandMark variant="mark" size={48} label="Mark, 48 px" />
        <BrandMark variant="mark" size={32} label="Full mark, 32 px" />
      </Row>
      <Row label="Small (16/32)">
        <BrandMark variant="small" size={32} label="Small mark, 32 px" />
        <BrandMark variant="small" size={24} label="Small mark, 24 px" />
        <BrandMark variant="small" size={18} label="Small mark, 18 px" />
        <BrandMark variant="small" size={16} label="Small mark, 16 px" />
      </Row>
      <Row label="App icon tile">
        <BrandMark tile size={128} label="App icon, 128 px" />
        <BrandMark tile size={64} label="App icon, 64 px" />
        <BrandMark tile size={32} label="App icon, 32 px" />
        <BrandMark tile size={16} label="App icon, 16 px" />
      </Row>
      <Row label="Lockup">
        <BrandMark variant="lockup" size={64} label="IntelyIDE" />
      </Row>
      <Row label="Stacked">
        <BrandMark variant="stacked" size={150} label="IntelyIDE" />
      </Row>
    </>
  );
}

function Column(props: { theme: "dark" | "light"; only: string | null }) {
  const show = (id: string) => !props.only || props.only === id;
  return (
    <div class="kit-col ui-theme-scope" data-theme={props.theme}>
      <div class="kit-col__head">
        <span class="kit-col__badge">{props.theme === "dark" ? <Moon size={12} /> : <Sun size={12} />}</span>
        <span>{props.theme === "dark" ? "Dark" : "Light"}</span>
      </div>
      {show("composite") && (
        <Section id="composite" title="Commit tool window preview" hint="Composition of kit components: title bar, rail, tree, composer, diff." wide>
          <Composite />
        </Section>
      )}
      <div class="kit-grid">
        {show("buttons") && <Section id="buttons" title="Buttons"><Buttons /></Section>}
        {show("selection") && <Section id="selection" title="Selection controls"><Selection /></Section>}
        {show("fields") && <Section id="fields" title="Fields"><Fields /></Section>}
        {show("badges") && <Section id="badges" title="Badges, pills, status"><Badges /></Section>}
        {show("feedback") && <Section id="feedback" title="Feedback"><Feedback side={props.theme === "dark" ? "right" : "left"} /></Section>}
        {show("overlays") && <Section id="overlays" title="Overlays"><Overlays /></Section>}
        {show("tree") && <Section id="tree" title="Tree and splitter"><TreeAndSplit theme={props.theme} /></Section>}
        {show("brand") && <Section id="brand" title="Brand"><Brand /></Section>}
        {show("foundations") && <Section id="foundations" title="Foundations"><Foundations /></Section>}
      </div>
    </div>
  );
}

export function Gallery() {
  initTheme();
  const q = new URLSearchParams(location.search);
  const only = q.get("section");
  const forced = q.get("theme");
  const [layout, setLayout] = createSignal<"both" | "dark" | "light">(forced === "dark" || forced === "light" ? forced : "both");
  return (
    <div class="kit-page ui-theme-scope" data-theme={layout() === "both" ? undefined : layout()}>
      <header class="kit-bar">
        <div class="kit-bar__title"><BrandMark size={16} />IntelySwitchIDE <span class="ui-text-3">UI kit</span></div>
        <div class="kit-bar__tools">
          <SegmentedControl size="sm" aria-label="Layout" value={layout()} onChange={setLayout} options={[{ value: "both", label: "Side by side" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
          <SegmentedControl size="sm" aria-label="Page theme" value={themePreference()} onChange={setThemePreference} options={[{ value: "system", label: "System", icon: Monitor }, { value: "dark", label: "Dark", icon: Moon }, { value: "light", label: "Light", icon: Sun }]} />
        </div>
      </header>
      <main class="kit-cols" data-layout={layout()}>
        {layout() !== "light" && <Column theme="dark" only={only} />}
        {layout() !== "dark" && <Column theme="light" only={only} />}
      </main>
      <Announcer />
    </div>
  );
}
