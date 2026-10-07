import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Picked, ScanProgress } from "../../ipc/picker";
import { toEngineError } from "../../ipc/rpc";
import type { RepoRedeem } from "../../ipc/workspaces";
import { adoptWorkspace, workspace } from "../../store/workspace";
import { activeSummary, createWorkspaceAndOpen, workspaces } from "../../store/workspaces";
import { announce, Button, Checkbox, Dialog, Input, Select, Spinner, toast } from "../../ui-kit";
import { closeScan, scanOpen } from "./dialogs";
import { workspaceErrorText } from "./errors";
import { uniqueWorkspaceName } from "./flows";
import { shortPath } from "./format";
import { kindLine, riskKeys, warningLines } from "./pickedText";
import { openPicker, type PickedItem } from "./pickerBridge";
import { nameProblem, suggestedName } from "./workspaceDraft";
import "./workspaceDialogs.css";

const POLL_MS = 200;
const ANNOUNCE_MS = 2000;
const TIME_LIMIT_S = 15;
const NAME_TEXT = { empty: "manage.nameEmpty", long: "manage.nameLong", taken: "manage.nameTaken" } as const;
type Target = "new" | "current" | "pick";

const relPath = (root: string, p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : shortPath(p));
const isRepo = (p: Picked): boolean => p.kind === "repo" || p.kind === "worktree" || p.kind === "submodule";

/**
 * Scan a folder for repositories (3.5). Results stream in while the scan runs; every non-duplicate repository is ticked,
 * the ones whose Git settings can run programs additionally need their own trust tick. The target is a new workspace, the open
 * one, or (from New workspace) the caller.
 */
export function ScanDialog() {
  const req = scanOpen;
  const open = () => req() !== null;
  const [root, setRoot] = createSignal<string | null>(null);
  const [home, setHome] = createSignal<string | null>(null);
  const [depth, setDepth] = createSignal("3");
  const [scanId, setScanId] = createSignal<string | null>(null);
  const [found, setFound] = createSignal<Picked[]>([]);
  const [progress, setProgress] = createSignal<ScanProgress | null>(null);
  const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [trusted, setTrusted] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [target, setTarget] = createSignal<Target>("new");
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [touched, setTouched] = createSignal(false);
  // The folder picker is a dialog of its own: this one steps aside while it is up, so the two never stack.
  const [choosing, setChoosing] = createSignal(false);
  let next = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let offProgress: (() => void) | undefined;
  let lastAnnounce = 0;
  let generation = 0;

  const hasWorkspace = () => activeSummary() !== undefined;
  const running = () => progress() !== null && !progress()!.done && !progress()!.cancelled;
  const inWorkspace = (p: Picked): boolean => target() === "current" && !!workspace()?.repos.some((r) => r.path === p.path);
  const rows = createMemo(() => found().filter(isRepo));
  const selectable = (p: Picked) => !inWorkspace(p);
  const chosen = createMemo(() => rows().filter((p) => ticked().has(p.token) && selectable(p)));
  const missingTrust = () => chosen().some((p) => p.configRisks.length > 0 && !trusted().has(p.token));
  const nameIssue = () => (target() === "new" ? nameProblem(name(), workspaces().map((w) => w.name)) : null);
  const canAdd = () => chosen().length > 0 && !missingTrust() && !nameIssue() && !busy();

  function stopTimers() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    offProgress?.();
    offProgress = undefined;
  }

  async function drain(id: string, gen: number) {
    for (;;) {
      const r = await ipc.picker.scanResults(id, next);
      if (gen !== generation) return;
      // A small scan can finish before the page subscribed to `picker:scan`: the results carry the latest progress too.
      const last = r.progress;
      if (last && (last.done || last.cancelled) && !progress()?.done && !progress()?.cancelled) {
        setProgress(last);
        stopTimers();
      }
      if (r.repos.length === 0 && r.next === next) return;
      next = r.next;
      batch(() => {
        setFound((l) => [...l, ...r.repos.filter((p) => !l.some((x) => x.token === p.token || x.path === p.path))]);
        setTicked((s) => new Set([...s, ...r.repos.map((p) => p.token)]));
      });
      if (r.repos.length === 0) return;
    }
  }

  async function start(path: string) {
    stopTimers();
    const gen = ++generation;
    batch(() => {
      setRoot(path);
      setFound([]);
      setTicked(new Set<string>());
      setTrusted(new Set<string>());
      setProgress(null);
      setError("");
      setName((n) => (n.trim() ? n : uniqueWorkspaceName(suggestedName(path))));
    });
    next = 0;
    try {
      const { scanId: id } = await ipc.picker.scanStart(path, { depth: Number(depth()) });
      if (gen !== generation) return void ipc.picker.scanCancel(id).catch(() => undefined);
      setScanId(id);
      setProgress({ scanId: id, visited: 0, found: 0, done: false, cancelled: false, truncated: false, reason: null, skippedProtected: [], skippedSymlinks: 0 });
      offProgress = ipc.picker.onScan((p) => {
        if (p.scanId !== id || gen !== generation) return;
        setProgress(p);
        if (p.done || p.cancelled) {
          stopTimers();
          void drain(id, gen);
        }
      });
      timer = setInterval(() => {
        void drain(id, gen);
        const p = progress();
        if (p && Date.now() - lastAnnounce >= ANNOUNCE_MS) {
          lastAnnounce = Date.now();
          announce(t("scan.progress", { found: p.found, visited: p.visited }));
        }
      }, POLL_MS);
    } catch (e) {
      setError(workspaceErrorText(e));
    }
  }

  async function choose() {
    setError("");
    setChoosing(true);
    try {
      const picked = await openPicker({ kind: "folder", purpose: "scanRoot" });
      const first = picked?.[0];
      if (first) await start(first.path);
    } catch (e) {
      setError(workspaceErrorText(e));
    } finally {
      setChoosing(false);
    }
  }

  async function stop() {
    const id = scanId();
    if (id) await ipc.picker.scanCancel(id).catch(() => undefined);
  }

  createEffect(
    on(req, (r) => {
      stopTimers();
      generation++;
      if (!r) return;
      batch(() => {
        setRoot(null);
        setFound([]);
        setProgress(null);
        setScanId(null);
        setTicked(new Set<string>());
        setTrusted(new Set<string>());
        setError("");
        setTouched(false);
        setName("");
        setTarget(r.target ?? (hasWorkspace() ? "new" : "new"));
      });
      void ipc.picker.start().then((s) => setHome(s.home)).catch(() => undefined);
      if (r.root) void start(r.root);
      else void choose();
    }),
  );
  onCleanup(() => {
    stopTimers();
    generation++;
    void stop();
  });

  const setAll = (on: boolean) => setTicked(on ? new Set(rows().filter(selectable).map((p) => p.token)) : new Set<string>());
  const toggle = (p: Picked, on: boolean) => setTicked((s) => new Set(on ? [...s, p.token] : [...s].filter((x) => x !== p.token)));

  async function add() {
    setTouched(true);
    if (!canAdd()) return;
    setBusy(true);
    setError("");
    const list = chosen();
    const redeems: RepoRedeem[] = list.map((p) => ({ token: p.token, ...(trusted().has(p.token) ? { trust: true } : {}) }));
    try {
      if (target() === "pick") {
        const items: PickedItem[] = list.map((p) => ({ ...p, ...(trusted().has(p.token) ? { trusted: true } : {}) }));
        req()?.onPick?.(items);
        closeScan();
      } else if (target() === "current") {
        const ws = await ipc.workspaces.addRepos(redeems);
        await adoptWorkspace(ws);
        toast.success(t("ws.toast.added", { count: list.length }));
        closeScan();
      } else {
        closeScan();
        await createWorkspaceAndOpen({ name: name().trim(), repos: redeems, origin: "scanned" });
      }
    } catch (e) {
      setError(workspaceErrorText(toEngineError(e)));
    } finally {
      setBusy(false);
    }
  }

  const limitText = (p: ScanProgress): string | null => {
    switch (p.reason) {
      case "depth":
        return t("scan.limit.depth", { depth: depth() });
      case "repos":
        return t("scan.limit.repos", { count: p.found });
      case "dirs":
        return t("scan.limit.dirs", { count: p.visited });
      case "time":
        return t("scan.limit.time", { seconds: TIME_LIMIT_S });
      default:
        return null;
    }
  };

  function onListKey(e: KeyboardEvent) {
    const boxes = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLInputElement>("input[type=checkbox]:not(:disabled)")];
    const at = boxes.indexOf(document.activeElement as HTMLInputElement);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      return setAll(true);
    }
    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? boxes.length - 1 : -2;
    if (to === -2) return;
    e.preventDefault();
    boxes[Math.max(0, Math.min(boxes.length - 1, to))]?.focus();
  }

  return (
    <Dialog
      open={open() && !choosing()}
      onClose={closeScan}
      title={t("scan.title")}
      size="lg"
      class="wsdlg"
      footer={
        <>
          <Button variant="ghost" onClick={closeScan}>{t("new.cancel")}</Button>
          <Button variant="primary" disabled={!canAdd()} loading={busy()} onClick={() => void add()}>
            {target() === "pick" ? t("scan.pickAdd", { count: chosen().length }) : t("scan.add", { count: chosen().length })}
          </Button>
        </>
      }
    >
      <div class="wsdlg__form">
        <div class="wsdlg__scanbar">
          <Button size="sm" variant="secondary" data-autofocus onClick={() => void choose()}>{t("scan.choose")}</Button>
          <Show when={root()}>{(r) => <span class="wsdlg__root" dir="ltr" title={r()}>{t("scan.root", { path: shortPath(r()) })}</span>}</Show>
          <Select
            size="sm"
            aria-label={t("scan.depth")}
            options={["1", "2", "3", "4", "5"].map((d) => ({ value: d, label: `${t("scan.depth")} ${d}` }))}
            value={depth()}
            onChange={(d) => {
              setDepth(d);
              if (root()) void start(root()!);
            }}
          />
        </div>
        <Show when={root() && home() && root()!.replace(/\/+$/, "") === home()!.replace(/\/+$/, "")}>
          <p class="wsdlg__notice">{t("scan.tooBroad")}</p>
        </Show>
        <Show when={progress()}>
          {(p) => (
            <div class="wsdlg__progress" role="status" aria-live="off">
              <Show when={running()} fallback={<span>{p().cancelled ? t("scan.cancelled") : t("scan.done")} · </span>}>
                <Spinner size={14} />
              </Show>
              <span>{t("scan.progress", { found: p().found, visited: p().visited })}</span>
              <Show when={running()}>
                <Button size="sm" variant="ghost" onClick={() => void stop()}>{t("scan.cancel")}</Button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={progress() && limitText(progress()!)}>{(text) => <p class="wsdlg__notice">{text()} {t("scan.tooBroad")}</p>}</Show>
        <Show when={(progress()?.skippedProtected.length ?? 0) > 0}>
          <p class="wsdlg__notice">{t("scan.skippedProtected", { names: progress()!.skippedProtected.join(", ") })}</p>
        </Show>
        <Show when={(progress()?.skippedSymlinks ?? 0) > 0}>
          <p class="wsdlg__hint">{t("scan.symlinks", { count: progress()!.skippedSymlinks })}</p>
        </Show>
        <Show when={progress() && !running() && rows().length === 0}>
          <div class="wsdlg__none">
            <p>{t("scan.none")}</p>
            <Button size="sm" variant="secondary" onClick={() => void choose()}>{t("scan.another")}</Button>
          </div>
        </Show>
        <Show when={rows().length > 0}>
          <div class="wsdlg__listhead">
            <h3>{t("scan.foundList")}</h3>
            <span class="wsdlg__buttons">
              <Button size="sm" variant="ghost" onClick={() => setAll(true)}>{t("scan.selectAll")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAll(false)}>{t("scan.selectNone")}</Button>
            </span>
          </div>
          <ul class="wsdlg__rows wsdlg__rows--scan" role="list" aria-label={t("scan.foundList")} onKeyDown={onListKey}>
            <For each={rows()}>
              {(p) => (
                <li class="wsdlg__row" data-disabled={inWorkspace(p) ? "" : undefined}>
                  <div class="wsdlg__row-main">
                    <Checkbox
                      label={<span class="wsdlg__scanname"><strong dir="ltr">{p.name}</strong> <Show when={relPath(root() ?? "", p.path) !== p.name}><span class="wsdlg__path" dir="ltr">{relPath(root() ?? "", p.path)}</span></Show></span>}
                      checked={ticked().has(p.token) && !inWorkspace(p)}
                      disabled={inWorkspace(p)}
                      onChange={(v) => toggle(p, v)}
                    />
                    <Show when={inWorkspace(p)}>
                      <span class="wsdlg__kind">{t("scan.alreadyAdded")}</span>
                    </Show>
                    <Show when={p.kind !== "repo"}>
                      <span class="wsdlg__kind">{kindLine(p)}</span>
                    </Show>
                  </div>
                  <For each={warningLines(p)}>{(line) => <p class="wsdlg__warn">{line}</p>}</For>
                  <Show when={p.configRisks.length > 0 && ticked().has(p.token) && !inWorkspace(p)}>
                    <div class="wsdlg__risk" role="group" aria-label={t("picker.risk.title")}>
                      <span>{t("picker.risk.body", { keys: riskKeys(p) })}</span>
                      <Checkbox label={t("picker.risk.confirm")} checked={trusted().has(p.token)} onChange={(v) => setTrusted((s) => new Set(v ? [...s, p.token] : [...s].filter((x) => x !== p.token)))} />
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <fieldset class="wsdlg__target">
            <legend>{t("scan.target")}</legend>
            <Show when={target() !== "pick"}>
              <label class="wsdlg__radio">
                <input type="radio" name="scan-target" checked={target() === "new"} onChange={() => setTarget("new")} />
                {t("scan.targetNew")}
              </label>
              <Show when={hasWorkspace()}>
                <label class="wsdlg__radio">
                  <input type="radio" name="scan-target" checked={target() === "current"} onChange={() => setTarget("current")} />
                  {t("scan.targetCurrent")}
                </label>
              </Show>
              <Show when={target() === "new"}>
                <label class="wsdlg__field">
                  <span>{t("scan.newName")}</span>
                  <Input value={name()} invalid={touched() && !!nameIssue()} onInput={(e) => (setName(e.currentTarget.value), setTouched(true))} autocomplete="off" />
                  <Show when={touched() && nameIssue()}>{(p) => <span class="wsdlg__problem" role="alert">{t(NAME_TEXT[p()])}</span>}</Show>
                </label>
              </Show>
            </Show>
          </fieldset>
        </Show>
        <Show when={error()}>
          <p class="wsdlg__problem" role="alert">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
}

export default ScanDialog;
