import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { toEngineError } from "../../ipc/rpc";
import { registerDropTarget } from "../../platform/dropzone";
import { createWorkspaceAndOpen, refreshRegistry, workspaces } from "../../store/workspaces";
import { Button, ChevronDown, ChevronUp, Checkbox, Dialog, FolderPlus, IconButton, Input, REPO_PALETTE, RepoBadge, Search, toast, Trash2 } from "../../ui-kit";
import { announce } from "../../ui-kit";
import { closeNewWorkspace, newWorkspaceOpen, openScan, scanOpen } from "./dialogs";
import { workspaceErrorText } from "./errors";
import { uniqueWorkspaceName } from "./flows";
import { shortPath } from "./format";
import { kindLine, riskKeys, warningLines } from "./pickedText";
import { openPicker, type PickedItem } from "./pickerBridge";
import { addPicked, duplicateBadges, freeColor, MAX_REPOS, moveDraft, nameProblem, needsTrust, patchDraft, redeemFrom, removeDraft, type RepoDraft } from "./workspaceDraft";
import "./workspaceDialogs.css";

const HEX = /^#[0-9a-fA-F]{6}$/;
const NAME_TEXT = { empty: "manage.nameEmpty", long: "manage.nameLong", taken: "manage.nameTaken" } as const;

/**
 * New workspace (3.4): a name, a colour and a list of repositories assembled from folders, a scan or a drop. Creating needs
 * every repository whose Git settings can run programs to be trusted; Rust enforces the same rule.
 */
export function NewWorkspaceDialog() {
  const open = () => newWorkspaceOpen() !== null;
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal<string>(REPO_PALETTE[0]);
  const [rows, setRows] = createSignal<RepoDraft[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const [touched, setTouched] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  // The folder picker and the Scan dialog are dialogs of their own: this one steps aside while they are up.
  const [picking, setPicking] = createSignal(false);
  const visible = () => open() && !picking() && scanOpen() === null;

  const problem = createMemo(() => nameProblem(name(), workspaces().map((w) => w.name)));
  const showName = () => touched() && problem();
  const untrusted = () => rows().some(needsTrust);
  const failedRows = () => rows().filter((r) => r.failed);
  const dirty = () => name().trim() !== "" || rows().length > 0;
  const sameBadge = createMemo(() => duplicateBadges(rows()));

  // Opened (fresh) with optional prefill from a multi-folder drop.
  createEffect(
    on(newWorkspaceOpen, (req) => {
      if (!req) return;
      batch(() => {
        setName("");
        setColor(freeColor(workspaces().map((w) => w.color)));
        setRows([]);
        setError("");
        setTouched(false);
        setNotice("");
        setConfirmDiscard(false);
        if (req.prefill?.length) add(req.prefill);
      });
    }),
  );

  function add(items: readonly PickedItem[]) {
    const r = addPicked(rows(), items);
    setRows(r.drafts);
    const notes: string[] = [];
    if (r.duplicates.length) notes.push(t("new.alreadyIn"));
    if (r.overLimit) notes.push(t("new.limit", { count: MAX_REPOS }));
    setNotice(notes.join(" "));
    if (notes.length) announce(notes.join(" "));
    if (!name().trim() && r.drafts.length) setName(uniqueWorkspaceName(r.drafts[0].picked.name));
  }

  async function addFolders() {
    setPicking(true);
    try {
      const picked = await openPicker({ kind: "folders", purpose: "workspaceRepo" });
      if (picked?.length) add(picked);
    } catch (e) {
      setError(workspaceErrorText(e));
    } finally {
      setPicking(false);
    }
  }

  function scan() {
    openScan({ target: "pick", onPick: (items) => add(items) });
  }

  // Dropped folders (validated by Rust, delivered through the inbox) become rows.
  createEffect(() => {
    if (!open()) return;
    const offTarget = registerDropTarget({ id: "workspace.new", priority: 120, label: t("new.title"), title: t("welcome.dropActive"), accepts: () => true, isActive: open, onDrop: () => undefined });
    void ipc.picker.dropListen(true).catch(() => undefined);
    const offDrop = ipc.picker.onDrop(() => void ipc.picker.takeDrop().then((items) => add(items)).catch(() => undefined));
    onCleanup(() => {
      offTarget();
      offDrop();
      void ipc.picker.dropListen(false).catch(() => undefined);
    });
  });

  function requestClose() {
    if (dirty() && !confirmDiscard()) return setConfirmDiscard(true);
    closeNewWorkspace();
  }

  async function create(openAfter: boolean) {
    setTouched(true);
    setError("");
    if (problem() || untrusted() || busy()) return;
    setBusy(true);
    try {
      const list = rows().filter((r) => !r.failed);
      const req = { name: name().trim(), color: color(), repos: list.map(redeemFrom), origin: "created" as const };
      if (openAfter) {
        closeNewWorkspace();
        await createWorkspaceAndOpen(req);
      } else {
        const { entry, reused } = await ipc.workspaces.create(req);
        await refreshRegistry();
        toast.success(reused ? t("ws.toast.reused", { name: entry.name }) : t("ws.toast.created", { name: entry.name }));
        closeNewWorkspace();
      }
    } catch (e) {
      const err = toEngineError(e);
      // A token that no longer works marks its row; the rest can still be created.
      const bad = err.detail ? rows().find((r) => r.picked.token === err.detail) : undefined;
      if (bad) setRows(patchDraft(rows(), bad.key, { failed: true }));
      setError(workspaceErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={visible()}
        onClose={requestClose}
        title={t("new.title")}
        size="lg"
        class="wsdlg"
        footer={
          <>
            <Button variant="ghost" onClick={requestClose}>{t("new.cancel")}</Button>
            <Button variant="secondary" disabled={busy()} onClick={() => void create(false)}>{t("new.create")}</Button>
            <Button variant="primary" disabled={busy() || untrusted() || !!problem()} loading={busy()} onClick={() => void create(true)}>{t("new.createOpen")}</Button>
          </>
        }
      >
        <form
          class="wsdlg__form"
          onSubmit={(e) => {
            e.preventDefault();
            void create(true);
          }}
        >
          <label class="wsdlg__field">
            <span>{t("new.name")}</span>
            <Input
              data-autofocus
              value={name()}
              placeholder={t("new.namePlaceholder")}
              invalid={!!showName()}
              autocomplete="off"
              onInput={(e) => (setName(e.currentTarget.value), setTouched(true))}
            />
            <Show when={showName()}>{(p) => <span class="wsdlg__problem" role="alert">{t(NAME_TEXT[p()])}</span>}</Show>
          </label>
          <div class="wsdlg__field" role="group" aria-label={t("new.color")}>
            <span>{t("new.color")}</span>
            <div class="wsdlg__swatches" role="radiogroup" aria-label={t("new.color")}>
              <For each={REPO_PALETTE}>
                {(c, i) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={color() === c}
                    aria-label={c}
                    tabindex={color() === c || (!REPO_PALETTE.includes(color() as never) && i() === 0) ? 0 : -1}
                    class="wsdlg__swatch"
                    style={{ "--wc": c }}
                    onClick={() => setColor(c)}
                    onKeyDown={(e) => {
                      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                      if (!step) return;
                      e.preventDefault();
                      const next = REPO_PALETTE[(i() + step + REPO_PALETTE.length) % REPO_PALETTE.length];
                      setColor(next);
                      queueMicrotask(() => (e.currentTarget.parentElement?.querySelector<HTMLElement>('[aria-checked="true"]'))?.focus());
                    }}
                  />
                )}
              </For>
              <Input
                size="sm"
                class="wsdlg__hex"
                aria-label={t("new.color")}
                placeholder="#8b6cf0"
                value={color()}
                invalid={!HEX.test(color())}
                onInput={(e) => HEX.test(e.currentTarget.value) && setColor(e.currentTarget.value.toLowerCase())}
              />
            </div>
          </div>
          <div class="wsdlg__repos">
            <div class="wsdlg__repos-head">
              <h3>{t("new.repos")}</h3>
              <span class="wsdlg__buttons">
                <Button size="sm" icon={FolderPlus} onClick={() => void addFolders()}>{t("new.addFolders")}</Button>
                <Button size="sm" variant="ghost" icon={Search} onClick={scan}>{t("new.scan")}</Button>
              </span>
            </div>
            <Show when={notice()}>
              <p class="wsdlg__notice" role="status">{notice()}</p>
            </Show>
            <Show when={rows().length > 0} fallback={<p class="wsdlg__empty">{t("new.reposEmpty")}</p>}>
              <ul class="wsdlg__rows" role="list">
                <For each={rows()}>
                  {(row, index) => (
                    <li class="wsdlg__row" data-failed={row.failed ? "" : undefined} onKeyDown={(e) => {
                      if (e.altKey && e.key === "ArrowUp") (e.preventDefault(), setRows(moveDraft(rows(), row.key, -1)));
                      if (e.altKey && e.key === "ArrowDown") (e.preventDefault(), setRows(moveDraft(rows(), row.key, 1)));
                    }}>
                      <div class="wsdlg__row-main">
                        <RepoBadge color={row.color} badge={row.badge || "?"} size={24} />
                        <div class="wsdlg__row-fields">
                          <Input size="sm" aria-label={t("new.repoName")} value={row.name} onInput={(e) => setRows(patchDraft(rows(), row.key, { name: e.currentTarget.value, nameEdited: true }))} />
                          <Input size="sm" class="wsdlg__badge" aria-label={t("new.repoBadge")} maxlength={2} value={row.badge} invalid={sameBadge().has(row.badge.toUpperCase())} onInput={(e) => setRows(patchDraft(rows(), row.key, { badge: e.currentTarget.value.toUpperCase().slice(0, 2), badgeEdited: true }))} />
                          <span class="wsdlg__dots" role="radiogroup" aria-label={t("new.repoColor")}>
                            <For each={REPO_PALETTE}>
                              {(c) => <button type="button" role="radio" aria-checked={row.color === c} aria-label={c} class="wsdlg__dot" style={{ "--wc": c }} onClick={() => setRows(patchDraft(rows(), row.key, { color: c }))} />}
                            </For>
                          </span>
                        </div>
                        <span class="wsdlg__tools">
                          <IconButton icon={ChevronUp} size="sm" label={t("new.moveUp")} disabled={index() === 0} onClick={() => setRows(moveDraft(rows(), row.key, -1))} />
                          <IconButton icon={ChevronDown} size="sm" label={t("new.moveDown")} disabled={index() === rows().length - 1} onClick={() => setRows(moveDraft(rows(), row.key, 1))} />
                          <IconButton icon={Trash2} size="sm" label={t("new.removeRepo", { name: row.name })} onClick={() => setRows(removeDraft(rows(), row.key))} />
                        </span>
                      </div>
                      <p class="wsdlg__path" dir="ltr">
                        {shortPath(row.picked.path)}
                        <Show when={row.picked.kind === "worktree" || row.picked.kind === "submodule"}>
                          <span class="wsdlg__kind">{row.picked.kind === "worktree" ? t("new.kind.worktree") : t("new.kind.submodule")}</span>
                        </Show>
                      </p>
                      <For each={warningLines(row.picked)}>{(line) => <p class="wsdlg__warn">{line}</p>}</For>
                      <Show when={sameBadge().has(row.badge.toUpperCase())}>
                        <p class="wsdlg__warn">{t("ws.repo.sameName")}</p>
                      </Show>
                      <Show when={row.picked.configRisks.length > 0}>
                        <div class="wsdlg__risk" role="group" aria-label={t("picker.risk.title")}>
                          <span>{t("picker.risk.body", { keys: riskKeys(row.picked) })}</span>
                          <Checkbox label={t("picker.risk.confirm")} checked={row.trusted} onChange={(v) => setRows(patchDraft(rows(), row.key, { trusted: v }))} />
                        </div>
                      </Show>
                      <Show when={row.failed}>
                        <p class="wsdlg__problem" role="alert">{kindLine(row.picked)} · {t("ws.error.tokenExpired")}</p>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={untrusted()}>
              <p class="wsdlg__hint">{t("new.trustHint")}</p>
            </Show>
          </div>
          <Show when={error()}>
            <p class="wsdlg__problem" role="alert">{error()}</p>
          </Show>
          <Show when={failedRows().length > 0 && rows().length > failedRows().length}>
            <Button variant="secondary" size="sm" onClick={() => void create(true)}>{t("new.partial")}</Button>
          </Show>
        </form>
      </Dialog>
      <Dialog
        open={confirmDiscard()}
        onClose={() => setConfirmDiscard(false)}
        title={t("new.discardTitle")}
        description={t("new.discardBody")}
        size="sm"
        role="alertdialog"
        initialFocus={() => document.querySelector<HTMLElement>("[data-discard-cancel]")}
        footer={
          <>
            <Button variant="ghost" data-discard-cancel onClick={() => setConfirmDiscard(false)}>{t("manage.cancel")}</Button>
            <Button variant="danger" onClick={() => (setConfirmDiscard(false), closeNewWorkspace())}>{t("new.discard")}</Button>
          </>
        }
      />
    </>
  );
}

export default NewWorkspaceDialog;
