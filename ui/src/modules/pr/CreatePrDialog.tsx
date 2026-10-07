import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, Dialog, GitPullRequestArrow, Input, Select, Skeleton, Switch, TextArea, toast, TriangleAlert } from "../../ui-kit";
import { prApi } from "./api";
import { confirmed, isJail, reasonText } from "./logic";
import type { CreatePlan, GhStatus } from "./types";

/**
 * Create PR: the draft from the commits ahead, the exact `gh` command, and a Create button that stays off until the
 * repo name and the head branch are typed. It never pushes; a branch without an upstream, a live head, the jail or a
 * missing gh switch the button off and say why.
 */
export default function CreatePrDialog(props: { open: boolean; repoId: string; repoName: string; status: GhStatus | undefined; onClose: () => void; onCreated: () => void }) {
  const [base, setBase] = createSignal<string | null>(null);
  const [draftPr, setDraftPr] = createSignal(true);
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [edited, setEdited] = createSignal(false);
  const [typedRepo, setTypedRepo] = createSignal("");
  const [typedHead, setTypedHead] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [command, setCommand] = createSignal("");
  const [plan] = createResource(
    () => (props.open && props.repoId ? ([props.repoId, base()] as const) : undefined),
    ([id, b]) => prApi().plan(id, b, true),
  );
  createEffect(on(() => props.open, (open) => open && (setBase(null), setDraftPr(true), setEdited(false), setTypedRepo(""), setTypedHead(""))));
  createEffect(() => {
    const p = plan();
    if (!p) return;
    if (!edited()) (setTitle(p.title), setBody(p.body));
    setCommand(p.command);
  });
  const head = () => plan()?.head ?? "";
  const effectiveBase = () => base() ?? plan()?.base ?? "";

  // The command shown is the one the backend would run for the current fields (debounced).
  createEffect(() => {
    const p = plan();
    const req = { title: title(), body: body(), base: effectiveBase(), draft: draftPr(), confirmRepo: "", confirmHead: "" };
    if (!props.open || !p?.head || !req.base) return;
    const timer = setTimeout(() => void prApi().preview(props.repoId, req).then(setCommand).catch(() => {}), 150);
    onCleanup(() => clearTimeout(timer));
  });

  /** Why Create is off, translated; the plan's refusal first, then what gh reports. */
  const blocker = createMemo((): string | undefined => {
    const p = plan();
    const s = props.status;
    if (p?.refusal) return reasonText(p.refusal);
    if (s && !s.installed) return reasonText({ code: "ghMissing" });
    if (s && isJail(s.blocked)) return reasonText({ code: s.blocked as string });
    if (s && s.authenticated === false) return reasonText({ code: "ghAuth" });
    return undefined;
  });
  const typedOk = () => confirmed(typedRepo(), props.repoName) && confirmed(typedHead(), head());
  const ready = () => !!plan() && !blocker() && typedOk() && title().trim() !== "" && !busy();

  async function create() {
    if (!ready()) return;
    setBusy(true);
    try {
      const res = await prApi().create(props.repoId, { title: title(), body: body(), base: effectiveBase(), draft: draftPr(), confirmRepo: typedRepo(), confirmHead: typedHead() });
      toast.success(draftPr() ? t("pr.create.doneDraft") : t("pr.create.done"), res.url);
      props.onClose();
      props.onCreated();
    } catch (e) {
      toast.error(t("pr.create.failed"), reasonText(e));
    } finally {
      setBusy(false);
    }
  }

  const repoParts = () => t("pr.create.typeRepo", { name: "\u0001" }).split("\u0001");
  const headParts = () => t("pr.create.typeHead", { name: "\u0001" }).split("\u0001");
  const plural = (p: CreatePlan) => t("pr.create.commits", { n: p.commits.length });
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="lg"
      title={t("pr.create.title")}
      description={t("pr.create.desc")}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("pr.cancel")}</Button>
          <Button variant="primary" icon={GitPullRequestArrow} loading={busy()} disabled={!ready()} onClick={() => void create()}>{draftPr() ? t("pr.create.actionDraft") : t("pr.create.action")}</Button>
        </>
      }
    >
      <Show when={plan()} fallback={<Skeleton height={160} />}>
        {(p) => (
          <div class="pr__form">
            <Show when={blocker()}>{(b) => <p class="pr__note" data-tone="warn" role="alert"><TriangleAlert size={14} />{b()}</p>}</Show>
            <div class="pr__grid">
              <label class="pr__field">
                <span>{t("pr.create.base")}</span>
                <Select aria-label={t("pr.create.baseAria")} value={effectiveBase()} onChange={setBase} options={(p().bases.length ? p().bases : [effectiveBase()]).map((b) => ({ value: b, label: b }))} />
              </label>
              <div class="pr__field">
                <span>{t("pr.create.head")}</span>
                <code class="pr__head ui-mono ui-truncate" title={p().upstream ?? ""}>{p().head ?? t("pr.create.noHead")}</code>
              </div>
              <div class="pr__field pr__field--switch">
                <span>{t("pr.create.draft")}</span>
                <Switch checked={draftPr()} onChange={setDraftPr} aria-label={t("pr.create.draftAria")} />
              </div>
            </div>
            <Show when={!draftPr()}><p class="pr__note" data-tone="info">{t("pr.create.readyNote")}</p></Show>
            <Show when={p().unpushed > 0}><p class="pr__note" data-tone="warn">{t("pr.create.unpushed", { n: p().unpushed })}</p></Show>
            <label class="pr__field">
              <span>{t("pr.create.titleLabel")}</span>
              <Input aria-label={t("pr.create.titleAria")} value={title()} onInput={(e) => (setTitle(e.currentTarget.value), setEdited(true))} spellcheck={false} invalid={title().trim() === ""} />
            </label>
            <label class="pr__field">
              <span>{t("pr.create.bodyLabel")}</span>
              <TextArea aria-label={t("pr.create.bodyAria")} minRows={5} maxRows={10} value={body()} onInput={(e) => (setBody(e.currentTarget.value), setEdited(true))} />
            </label>
            <details class="pr__commits">
              <summary>{plural(p())}</summary>
              <ul>
                <For each={p().commits}>{(c) => <li><code class="ui-mono">{c.sha.slice(0, 7)}</code> {c.subject}</li>}</For>
              </ul>
            </details>
            <div class="pr__field">
              <span>{t("pr.create.command")}</span>
              <pre class="pr__cmd ui-mono" aria-label={t("pr.create.commandAria")}>{command()}</pre>
              <span class="pr__hint">{t("pr.create.commandHint")}</span>
            </div>
            <div class="pr__confirm">
              <label class="pr__field">
                <span>{repoParts()[0]}<code class="ui-mono">{props.repoName}</code>{repoParts()[1]}</span>
                <Input aria-label={t("pr.create.typeRepoAria")} value={typedRepo()} onInput={(e) => setTypedRepo(e.currentTarget.value)} spellcheck={false} autocomplete="off" />
              </label>
              <label class="pr__field">
                <span>{headParts()[0]}<code class="ui-mono">{head()}</code>{headParts()[1]}</span>
                <Input aria-label={t("pr.create.typeHeadAria")} value={typedHead()} onInput={(e) => setTypedHead(e.currentTarget.value)} spellcheck={false} autocomplete="off" />
              </label>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
