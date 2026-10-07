import { createMemo, createSignal, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { Capabilities, Picked, PickWarning } from "../../ipc/picker";
import { announce, Button, Checkbox, CircleAlert, File, Folder, FolderGit2, GitBranch, Input, TriangleAlert } from "../../ui-kit";
import { asEngineError, effective, errorText, mainName } from "./errors";
import { markTrusted } from "./store";

const WARN: Record<PickWarning, MessageKey> = {
  cloudFolder: "picker.warn.cloud",
  network: "picker.warn.network",
  externalVolume: "picker.warn.network",
  insideIgnored: "picker.warn.ignored",
  foreignOwner: "picker.warn.owner",
  gitfileRedirect: "picker.warn.redirect",
  homeIsRepo: "picker.warn.homeRepo",
  gitSymlink: "picker.warn.gitSymlink",
  limitedSupport: "picker.warn.limitedSupport",
};

function kindText(p: Picked): string | null {
  switch (p.kind) {
    case "repo":
      return t("picker.kind.repo");
    case "worktree":
      return t("picker.kind.worktree", { main: mainName(p.main) });
    case "submodule":
      return t("picker.kind.submodule");
    case "subfolder":
      return t("picker.kind.subfolder", { root: p.root ? p.root.name : "" });
    case "bare":
      return t("picker.kind.bare");
    case "gitDir":
      return t("picker.kind.gitDir");
    case "notGit":
      return t("picker.kind.notGit");
    default:
      return null;
  }
}

interface CardProps {
  picked: Picked;
  mode: Capabilities["mode"] | undefined;
  trusted: boolean;
  onTrust(on: boolean): void;
  onInitialized(p: Picked): void;
}

/** One validated result: what it is, its warnings, the trust card, and for a non-repository the `git init` flow. */
export function ResultCard(props: CardProps) {
  const eff = () => effective(props.picked);
  const warnings = () => [...new Set([...props.picked.warnings, ...(eff()?.warnings ?? [])])];
  const risks = () => eff()?.configRisks ?? [];
  const [initOpen, setInitOpen] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const blocked = () => props.picked.kind === "bare" || (props.picked.kind === "gitDir" && !props.picked.root);
  const readOnly = () => props.mode === "readOnly";

  async function init(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const repo = await ipc.picker.gitInit(props.picked.token, typed());
      announce(t("picker.init.done"));
      props.onInitialized(repo);
    } catch (e) {
      setError(errorText(asEngineError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article class="pp-result" data-kind={props.picked.kind} data-blocked={blocked() || props.picked.kind === "notGit" ? "" : undefined}>
      <header class="pp-result__head">
        <span class="pp-result__icon" aria-hidden="true">
          {props.picked.kind === "file" ? <File size={16} /> : eff()?.kind === "repo" || eff()?.kind === "worktree" || eff()?.kind === "submodule" ? <FolderGit2 size={16} /> : <Folder size={16} />}
        </span>
        <div class="pp-result__titles">
          <h3 class="pp-result__name" dir="auto">
            {props.picked.name}
          </h3>
          <p class="pp-result__path" dir="ltr">
            {props.picked.path}
          </p>
        </div>
        <Show when={props.picked.branch}>
          <span class="pp-chip pp-chip--branch">
            <GitBranch size={11} aria-hidden="true" /> {props.picked.branch}
          </span>
        </Show>
      </header>

      <Show when={props.picked.kind !== "notGit" ? kindText(props.picked) : null}>
        {(text) => (
          <p class="pp-result__kind" role={blocked() ? "alert" : undefined}>
            {blocked() && <CircleAlert size={14} aria-hidden="true" />} {text()}
          </p>
        )}
      </Show>

      <Show when={warnings().length > 0}>
        <ul class="pp-warnings">
          <For each={warnings()}>
            {(w) => (
              <li>
                <TriangleAlert size={13} aria-hidden="true" />
                <span>{t(WARN[w], { target: props.picked.gitfileTarget ?? eff()?.gitfileTarget ?? "" })}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={risks().length > 0}>
        <section class="pp-card pp-card--warn" aria-labelledby={`pp-risk-${props.picked.token}`}>
          <h4 class="pp-card__title" id={`pp-risk-${props.picked.token}`}>
            <TriangleAlert size={15} aria-hidden="true" /> {t("picker.risk.title")}
          </h4>
          <p class="pp-card__text">{t("picker.risk.body", { keys: risks().join(", ") })}</p>
          <ul class="pp-keys" dir="ltr">
            <For each={risks()}>{(k) => <li>{k}</li>}</For>
          </ul>
          <Checkbox checked={props.trusted} onChange={props.onTrust} label={t("picker.risk.confirm")} />
        </section>
      </Show>

      <Show when={props.picked.kind === "notGit"}>
        <section class="pp-card" aria-labelledby={`pp-init-${props.picked.token}`}>
          <h4 class="pp-card__title" id={`pp-init-${props.picked.token}`}>
            {t("picker.init.title")}
          </h4>
          <p class="pp-card__text">{t("picker.init.body")}</p>
          <Show when={readOnly()}>
            <p class="pp-hint">{t("picker.init.readOnly")}</p>
          </Show>
          <Show
            when={initOpen() && !readOnly()}
            fallback={
              <div class="pp-card__actions">
                <Button size="sm" disabled={readOnly()} onClick={() => setInitOpen(true)}>
                  {t("picker.init.action")}
                </Button>
              </div>
            }
          >
            <form
              class="pp-init"
              onSubmit={(e) => {
                e.preventDefault();
                void init();
              }}
            >
              <label for={`pp-init-in-${props.picked.token}`}>{t("picker.init.confirm", { name: props.picked.name })}</label>
              <Input
                id={`pp-init-in-${props.picked.token}`}
                size="sm"
                value={typed()}
                data-autofocus
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setTyped(e.currentTarget.value)}
                invalid={!!error()}
              />
              <Show when={error()}>
                <p class="pp-hint pp-hint--err" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="pp-card__actions">
                <Button type="submit" size="sm" variant="primary" loading={busy()} disabled={typed().trim().normalize("NFC") !== props.picked.name.normalize("NFC")}>
                  {t("picker.init.run")}
                </Button>
              </div>
            </form>
          </Show>
        </section>
      </Show>
    </article>
  );
}

export interface ReviewProps {
  items: Picked[];
  mode: Capabilities["mode"] | undefined;
  onBack(): void;
  onCancel(): void;
  onConfirm(items: Picked[]): void;
}

/** The result card step: confirm one or several validated folders (trust gating included). */
export function Review(props: ReviewProps) {
  const [items, setItems] = createSignal(props.items);
  const [trust, setTrust] = createSignal<ReadonlySet<string>>(new Set());
  const effectives = createMemo(() => items().map((i) => effective(i)).filter((p): p is Picked => !!p));
  const untrusted = () => effectives().some((p) => p.configRisks.length > 0 && !trust().has(p.token));
  const single = () => items().length === 1;
  const subfolder = () => single() && (items()[0].kind === "subfolder" || items()[0].kind === "gitDir");
  const canConfirm = () => effectives().length > 0 && !untrusted();

  const label = () => {
    if (!single()) return `${t("picker.choose")} (${effectives().length})`;
    return subfolder() ? t("picker.useRoot") : t("picker.useThis");
  };

  const setTrusted = (token: string, on: boolean) => {
    const next = new Set(trust());
    if (on) next.add(token);
    else next.delete(token);
    setTrust(next);
  };

  function confirm(): void {
    const out = effectives();
    for (const p of out) if (p.configRisks.length > 0 && trust().has(p.token)) markTrusted(p);
    props.onConfirm(out);
  }

  return (
    <div class="pp-review">
      <div class="pp-review__list">
        <For each={items()}>
          {(it, idx) => (
            <ResultCard
              picked={it}
              mode={props.mode}
              trusted={trust().has(effective(it)?.token ?? "")}
              onTrust={(on) => setTrusted(effective(it)?.token ?? "", on)}
              onInitialized={(repo) => setItems(items().map((x, k) => (k === idx() ? repo : x)))}
            />
          )}
        </For>
      </div>
      <div class="pp-actions">
        <Show when={untrusted()}>
          <span class="pp-hint pp-actions__hint" id="pp-trust-hint">
            {t("picker.trust.disabledReason")}
          </span>
        </Show>
        <Button variant="ghost" onClick={props.onCancel}>
          {t("picker.cancel")}
        </Button>
        <Button onClick={props.onBack}>{t("picker.perm.other")}</Button>
        <Button variant="primary" disabled={!canConfirm()} aria-describedby={untrusted() ? "pp-trust-hint" : undefined} onClick={confirm}>
          {label()}
        </Button>
      </div>
    </div>
  );
}
