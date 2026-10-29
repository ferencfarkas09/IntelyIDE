import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { Encoding, Eol } from "../../ipc/files";
import { vibeIpc, type NotesPlan } from "../../ipc/vibe";
import { execute } from "../../platform/commands";
import { requestNewRun } from "../../platform/newRun";
import type { TabInstance } from "../../platform/tabs";
import { errorText } from "../../store/snapshots";
import { repoConfig, repos } from "../../store/workspace";
import { Badge, Button, EmptyState, ExternalLink, FilePlus, FileText, ProgressBar, RefreshCw, RepoBadge, Save, Skeleton, Sparkles, TextArea, toast, TriangleAlert } from "../../ui-kit";
import { byteLength, editableReason, FILE_MAX, fromDisk, planWarnings, SECRET_CHECK_MAX, sizeLevel, SKELETON, starterPrompt, toDiskText, type Warning } from "./logic";
import "./projectnotes.css";

const FILE = "CLAUDE.md";

type Loaded =
  | { state: "missing" }
  | { state: "link" }
  | { state: "unreadable"; message: string }
  /** `text` is the editor form (LF line endings); `eol` and `encoding` are put back on save. `readOnly` says why it is not editable here. */
  | { state: "file"; text: string; mtimeMs: number; eol: Eol; encoding: Encoding; readOnly?: "mixed" | "encoding" };

const fmtKb = (n: number): string => `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;

function warningText(w: Warning): string {
  if (w.code === "overFile") return t("pnotes.warn.overFile", { size: fmtKb(w.size), max: fmtKb(FILE_MAX) });
  if (w.code === "overTotal") return t("pnotes.warn.overTotal");
  if (w.code === "leftOut") return t("pnotes.warn.leftOut", { count: w.count });
  if (w.code === "imports") return t("pnotes.warn.imports");
  return t("pnotes.warn.secret");
}

/** Project notes: the repository's CLAUDE.md, edited in place, and exactly what a Claude run started now would be told. */
export default function NotesTab(props: { tab?: TabInstance }) {
  const [repoId, setRepoId] = createSignal<string | undefined>((props.tab?.params?.repoId as string | undefined) ?? repos()[0]?.id);
  const [loaded, setLoaded] = createSignal<Loaded | undefined>();
  const [draft, setDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [plan, setPlan] = createSignal<NotesPlan | undefined>();
  const [planError, setPlanError] = createSignal<string | undefined>();
  const [looksSecret, setLooksSecret] = createSignal(false);
  const [open, setOpen] = createSignal<string | undefined>();
  /** A repository switch or a refresh that waits for "discard the unsaved changes?". */
  const [pending, setPending] = createSignal<{ to: string | undefined } | undefined>();
  createEffect(() => !repoId() && repos()[0] && setRepoId(repos()[0].id));
  // every load is numbered: an answer for a repository that is no longer shown is dropped
  let seq = 0;

  const load = async (id: string, n: number) => {
    setLoaded(undefined);
    let next: Loaded;
    let text = "";
    try {
      const entry = (await ipc.files.listDir(id, "")).find((e) => e.name === FILE);
      if (!entry) next = { state: "missing" };
      else if (entry.kind !== "file") next = { state: "link" };
      else {
        const r = await ipc.files.readFile(id, FILE);
        if (r.text === undefined || r.binary || r.tooLarge) next = { state: "unreadable", message: t("pnotes.unreadable") };
        else {
          const encoding = r.encoding ?? "utf8";
          text = fromDisk(r.text, r.eol);
          next = { state: "file", text, mtimeMs: r.mtimeMs, eol: r.eol, encoding, readOnly: editableReason(r.eol, encoding) };
        }
      }
    } catch (e) {
      next = { state: "unreadable", message: errorText(e) };
    }
    if (n !== seq) return;
    setLoaded(next);
    setDraft(text);
  };
  const loadPlan = async (id: string, n: number) => {
    setPlanError(undefined);
    try {
      const p = await vibeIpc().projectNotes([id]);
      if (n === seq) setPlan(p);
    } catch (e) {
      if (n !== seq) return;
      setPlan(undefined);
      setPlanError(errorText(e));
    }
  };
  const reload = () => {
    const id = repoId();
    const n = ++seq;
    if (id) void Promise.all([load(id, n), loadPlan(id, n)]);
  };
  createEffect(on(repoId, reload));

  const dirty = () => {
    const l = loaded();
    return l?.state === "file" ? draft() !== l.text : l?.state === "missing" && draft() !== "";
  };
  /** Switching the repository or refreshing drops unsaved changes only after the person says so. */
  const goTo = (to: string | undefined) => {
    if (dirty()) return void setPending({ to });
    if (to === undefined || to === repoId()) reload();
    else setRepoId(to);
  };
  const discardAndGo = () => {
    const p = pending();
    setPending(undefined);
    setDraft(loaded()?.state === "file" ? (loaded() as { text: string }).text : "");
    if (p) goTo(p.to);
  };

  // A secret-looking value in the file would go into every run: the app's masker says whether it would change anything.
  // Asked 300 ms after the last keystroke, for the first 256 KB only, so typing never waits for it.
  let maskTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(draft, (text) => {
      clearTimeout(maskTimer);
      maskTimer = setTimeout(() => {
        const head = text.slice(0, SECRET_CHECK_MAX);
        void vibeIpc().maskText(head).then((m) => text === draft() && setLooksSecret(m !== head), () => setLooksSecret(false));
      }, 300);
    }),
  );
  onCleanup(() => clearTimeout(maskTimer));
  const bytes = createMemo(() => byteLength(draft()));
  const warnings = createMemo(() => [...(plan() ? planWarnings(plan()!) : []), ...(looksSecret() ? [{ code: "secret" } as Warning] : [])]);

  const save = async () => {
    const id = repoId();
    const l = loaded();
    if (!id || !l || (l.state !== "file" && l.state !== "missing") || (l.state === "file" && l.readOnly)) return;
    setSaving(true);
    try {
      const text = draft();
      if (l.state === "file") {
        // the backend refuses a file whose modification time moved; reading it once more also catches a change within the same millisecond
        const now = await ipc.files.readFile(id, FILE);
        if (now.mtimeMs !== l.mtimeMs || fromDisk(now.text ?? "", now.eol) !== l.text) throw Object.assign(new Error("changed on disk"), { code: "staleFile" });
      }
      const eol: Eol = l.state === "file" ? l.eol : "lf";
      const encoding: Encoding = l.state === "file" ? l.encoding : "utf8";
      const r = await ipc.files.writeFile(id, FILE, toDiskText(text, eol), l.state === "file" ? l.mtimeMs : 0, { encoding });
      setLoaded({ state: "file", text, mtimeMs: r.mtimeMs, eol, encoding });
      toast.success(t("pnotes.saved"));
      void loadPlan(id, seq);
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast.error(code === "staleFile" ? t("pnotes.stale") : t("pnotes.saveFailed"), code === "staleFile" ? undefined : errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    const id = repoId();
    if (!id) return;
    // Ask: the agent reads untrusted repository text, so every edit and command waits for a yes (the person can pick another mode)
    const ok = await requestNewRun({ prompt: starterPrompt(repoConfig(id)?.name ?? id, loaded()?.state === "file"), repoIds: [id], permission: "ask" });
    if (!ok) toast.warn(t("pnotes.noDialog"));
  };

  return (
    <div class="pnotes">
      <Show when={repos().length > 0} fallback={<EmptyState icon={FileText} title={t("pnotes.noRepo")} />}>
        <div class="pnotes__bar">
          <div class="pnotes__repos" role="tablist" aria-label={t("pnotes.repo")}>
            <For each={repos()}>
              {(r) => (
                <button type="button" role="tab" class="pnotes__repo" aria-selected={repoId() === r.id} onClick={() => goTo(r.id)}>
                  <RepoBadge color={r.color} badge={r.badge} size={16} />
                  <span class="ui-truncate">{r.name}</span>
                </button>
              )}
            </For>
          </div>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => goTo(undefined)}>{t("pnotes.refresh")}</Button>
          <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => void generate()}>{loaded()?.state === "file" ? t("pnotes.improve") : t("pnotes.generate")}</Button>
        </div>
        <Show when={pending()}>
          <div class="pnotes__pending" role="alertdialog" aria-label={t("pnotes.unsaved")}>
            <TriangleAlert size={14} />
            <span>{t("pnotes.unsaved")}</span>
            <Button size="sm" variant="danger" onClick={discardAndGo}>{t("pnotes.discard")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(undefined)}>{t("pnotes.keepEditing")}</Button>
          </div>
        </Show>
        <p class="pnotes__lead">{t("pnotes.lead")}</p>

        <section class="pnotes__card" aria-labelledby="pnotes-file">
          <h3 class="pnotes__h" id="pnotes-file">{t("pnotes.fileTitle")}</h3>
          <Show when={loaded()} fallback={<Skeleton height={120} />}>
            {(l) => (
              <>
                <Show when={l().state === "missing"}>
                  <p class="pnotes__hint">{t("pnotes.missing")}</p>
                  <Show when={draft() === ""}>
                    <div class="pnotes__row">
                      <Button size="sm" icon={FilePlus} onClick={() => setDraft(SKELETON)}>{t("pnotes.create")}</Button>
                    </div>
                  </Show>
                </Show>
                <Show when={l().state === "link"}>
                  <p class="pnotes__warn" role="status"><TriangleAlert size={14} /> {t("pnotes.link")}</p>
                </Show>
                <Show when={l().state === "unreadable"}>
                  <p class="pnotes__warn" role="alert">{(l() as { message: string }).message}</p>
                </Show>
                <Show when={l().state === "file" && (l() as { readOnly?: string }).readOnly}>
                  {(why) => <p class="pnotes__warn" role="status"><TriangleAlert size={14} /> {t(`pnotes.readOnly.${why()}` as MessageKey)}</p>}
                </Show>
                <Show when={l().state === "file" || (l().state === "missing" && draft() !== "")}>
                  <TextArea class="ui-mono pnotes__text" aria-label={t("pnotes.fileTitle")} minRows={10} maxRows={28} value={draft()} readOnly={l().state === "file" && !!(l() as { readOnly?: string }).readOnly} onInput={(e) => setDraft(e.currentTarget.value)} />
                  <div class="pnotes__meter" data-level={sizeLevel(bytes())}>
                    <ProgressBar size="sm" value={(100 * bytes()) / FILE_MAX} tone={sizeLevel(bytes()) === "over" ? "danger" : sizeLevel(bytes()) === "large" ? "warn" : "accent"} aria-label={t("pnotes.meterAria")} />
                    <span class="ui-tnum">{t("pnotes.meter", { size: fmtKb(bytes()), max: fmtKb(FILE_MAX) })}</span>
                    <Show when={sizeLevel(bytes()) !== "ok"}>
                      <span class="pnotes__level">{t(`pnotes.level.${sizeLevel(bytes())}` as MessageKey)}</span>
                    </Show>
                  </div>
                  <div class="pnotes__row">
                    <Button size="sm" icon={Save} loading={saving()} disabled={!dirty()} onClick={() => void save()}>{t("pnotes.save")}</Button>
                    <Show when={dirty() && l().state === "file"}>
                      <Button size="sm" variant="ghost" onClick={() => setDraft((l() as { text: string }).text)}>{t("pnotes.revert")}</Button>
                    </Show>
                    <Show when={l().state === "file"}>
                      <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void execute("editor.openFile", { repoId: repoId(), path: FILE })}>{t("pnotes.openEditor")}</Button>
                    </Show>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </section>

        <section class="pnotes__card" aria-labelledby="pnotes-told">
          <h3 class="pnotes__h" id="pnotes-told">{t("pnotes.toldTitle")}</h3>
          <p class="pnotes__hint">{t("pnotes.toldLead")}</p>
          <Show when={warnings().length > 0}>
            <ul class="pnotes__warnings">
              <For each={warnings()}>{(w) => <li class="pnotes__warn"><TriangleAlert size={14} /> {warningText(w)}</li>}</For>
            </ul>
          </Show>
          <Show when={planError()}>{(m) => <p class="pnotes__warn" role="alert">{m()}</p>}</Show>
          <Show when={plan()}>
            {(p) => (
              <>
                <div class="pnotes__meter" data-level={p().total >= p().totalMax ? "over" : "ok"}>
                  <ProgressBar size="sm" value={(100 * p().total) / p().totalMax} tone={p().total >= p().totalMax ? "danger" : "accent"} aria-label={t("pnotes.totalAria")} />
                  <span class="ui-tnum">{t("pnotes.total", { size: fmtKb(p().total), max: fmtKb(p().totalMax), count: p().files.length })}</span>
                </div>
                <Show when={p().files.length > 0} fallback={<p class="pnotes__hint">{t("pnotes.toldNone")}</p>}>
                  <ol class="pnotes__files">
                    <For each={p().files}>
                      {(f) => (
                        <li class="pnotes__told">
                          <button type="button" class="pnotes__toldhead" aria-expanded={open() === f.path} onClick={() => setOpen(open() === f.path ? undefined : f.path)}>
                            <Badge size="sm" tone={f.scope === "user" ? "info" : "accent"}>{f.scope === "user" ? t("pnotes.scope.user") : t("pnotes.scope.project")}</Badge>
                            <span class="pnotes__path ui-mono">{f.path}</span>
                            <span class="ui-tnum pnotes__len">{fmtKb(f.length)}</span>
                            <Show when={f.shortened}><Badge size="sm" tone="warn">{t("pnotes.shortened")}</Badge></Show>
                          </button>
                          <Show when={open() === f.path}>
                            <pre class="pnotes__pre" tabIndex={0}>{f.text.trim()}</pre>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
                <p class="pnotes__hint">{t("pnotes.toldFoot")}</p>
              </>
            )}
          </Show>
        </section>
      </Show>
    </div>
  );
}
