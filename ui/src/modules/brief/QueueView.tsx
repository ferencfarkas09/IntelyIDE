import { createMemo, createSignal, For, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { agentRoles } from "../../store/agents";
import { repoName } from "../../store/actions";
import { repos } from "../../store/workspace";
import { ArrowDown, ArrowUp, Badge, Button, Checkbox, EmptyState, FileSearch, Icon, IconButton, Input, ListChecks, Lock, Moon, Pause, Play, Plus, ProgressBar, Select, ShieldCheck, Square, TextArea, Trash2, Zap, toast } from "../../ui-kit";
import { openInspector, openReview } from "../inspector/openers";
import { FORM_ERROR_KEY, LIMITS, PAUSED_KEY, reasonKey, STATE_KEY, STATE_TONE, timePercent, tokenPercent, validate } from "./logic";
import { addItem, arm, clearFinished, moveItem, night, removeItem, stopCurrent } from "./store";
import type { NightItem } from "./types";

const firstLine = (s: string): string => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function ItemRow(props: { item: NightItem; index: number; last: boolean; now: number }) {
  const it = () => props.item;
  const queued = () => it().state === "queued";
  const reason = () => {
    const k = reasonKey(it().reason);
    return k ? t(k) : it().reason;
  };
  const run = () => ({ runId: it().runId ?? "", title: firstLine(it().prompt), role: it().roleId, repoIds: it().repoIds });
  return (
    <li class="nq__item" data-state={it().state} data-item={it().id}>
      <span class="nq__n ui-tnum" aria-hidden="true">{props.index + 1}</span>
      <div class="nq__main">
        <div class="nq__line">
          <Badge size="sm" tone={STATE_TONE[it().state]}>{t(STATE_KEY[it().state])}</Badge>
          <span class="nq__prompt ui-truncate" title={it().prompt}>{firstLine(it().prompt)}</span>
        </div>
        <div class="nq__meta">
          <span>{it().roleId}</span>
          <For each={it().repoIds}>{(r) => <Badge size="sm" tone="neutral">{repoName(r)}</Badge>}</For>
          <span class="ui-tnum">{t("night.budget", { minutes: it().maxMinutes, tokens: fmt.number(it().maxTokens, "compact") })}</span>
          <Show when={it().tokensUsed > 0}><span class="ui-tnum">{t("night.used", { tokens: fmt.number(it().tokensUsed, "compact") })}</span></Show>
        </div>
        <Show when={it().state === "running"}>
          <div class="nq__bars">
            <ProgressBar size="sm" aria-label={t("night.timeAria")} value={timePercent(it(), props.now)} tone={timePercent(it(), props.now) >= 85 ? "warn" : "accent"} />
            <ProgressBar size="sm" aria-label={t("night.tokensAria")} value={tokenPercent(it())} tone={tokenPercent(it()) >= 85 ? "warn" : "accent"} />
          </div>
        </Show>
        <Show when={queued() && it().waiting}><p class="nq__note">{t("night.waiting", { why: it().waiting ?? "" })}</p></Show>
        <Show when={reason() && it().state !== "running"}><p class="nq__note" data-tone={it().state === "failed" ? "danger" : "warn"}>{reason()}</p></Show>
      </div>
      <div class="nq__acts">
        <Show when={queued()}>
          <IconButton size="sm" icon={ArrowUp} label={t("night.moveUp")} disabled={props.index === 0} onClick={() => void moveItem(it().id, -1)} />
          <IconButton size="sm" icon={ArrowDown} label={t("night.moveDown")} disabled={props.last} onClick={() => void moveItem(it().id, 1)} />
        </Show>
        <Show when={it().runId}>
          <IconButton size="sm" icon={FileSearch} label={t("night.inspect")} onClick={() => void openInspector(run())} />
          <IconButton size="sm" icon={ListChecks} label={t("night.review")} onClick={() => void openReview(run())} />
        </Show>
        <IconButton
          size="sm"
          icon={Trash2}
          label={t("night.remove")}
          tooltip={it().state === "running" ? t("night.removeRunning") : t("night.remove")}
          disabled={it().state === "running"}
          onClick={async () => {
            const e = await removeItem(it().id);
            if (e) toast.error(t("night.toast.removeFailed"), e.message);
          }}
        />
      </div>
    </li>
  );
}

function AddForm(props: { count: number; cap: number }) {
  const [role, setRole] = createSignal("");
  const [repoIds, setRepoIds] = createSignal<string[]>([]);
  const [prompt, setPrompt] = createSignal("");
  const [minutes, setMinutes] = createSignal(String(LIMITS.defaultMinutes));
  const [tokens, setTokens] = createSignal(String(LIMITS.defaultTokens));
  const [busy, setBusy] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  const roles = createMemo(() => agentRoles().map((r) => ({ value: r.name, label: r.name })));
  const draft = () => ({ roleId: role(), repoIds: repoIds(), prompt: prompt(), maxMinutes: Number(minutes()), maxTokens: Number(tokens()) });
  const problem = () => validate(draft(), props.count, props.cap);
  const toggle = (id: string) => setRepoIds((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));

  const submit = async () => {
    const p = problem();
    if (p) return void toast.error(t(FORM_ERROR_KEY[p]));
    setBusy(true);
    const e = await addItem(draft());
    setBusy(false);
    if (e) return void toast.error(t("night.toast.addFailed"), e.message);
    setPrompt("");
    setShown(false);
  };

  return (
    <section class="nq__card" aria-label={t("night.add.title")}>
      <Show
        when={shown()}
        fallback={
          <Button variant="secondary" icon={Plus} disabled={props.count >= props.cap} onClick={() => setShown(true)}>
            {props.count >= props.cap ? t("night.add.capReached", { cap: props.cap }) : t("night.add.open")}
          </Button>
        }
      >
        <h3 class="nq__title">{t("night.add.title")}</h3>
        <div class="nq__form">
          <label class="nq__field">
            <span>{t("night.add.role")}</span>
            <Select size="sm" aria-label={t("night.add.role")} value={role()} onChange={setRole} placeholder={t("night.add.rolePlaceholder")} options={roles()} />
          </label>
          <fieldset class="nq__field nq__repos">
            <legend>{t("night.add.repos")}</legend>
            <For each={repos()}>{(r) => <Checkbox size="sm" checked={repoIds().includes(r.id)} onChange={() => toggle(r.id)} label={r.name} />}</For>
          </fieldset>
          <label class="nq__field nq__wide">
            <span>{t("night.add.prompt")}</span>
            <TextArea minRows={3} maxRows={8} aria-label={t("night.add.prompt")} placeholder={t("night.add.promptPlaceholder")} value={prompt()} onInput={(e) => setPrompt(e.currentTarget.value)} />
          </label>
          <label class="nq__field">
            <span>{t("night.add.minutes")}</span>
            <Input size="sm" type="number" min={LIMITS.minMinutes} max={LIMITS.maxMinutes} aria-label={t("night.add.minutes")} value={minutes()} onInput={(e) => setMinutes(e.currentTarget.value)} />
          </label>
          <label class="nq__field">
            <span>{t("night.add.tokens")}</span>
            <Input size="sm" type="number" step={10_000} min={LIMITS.minTokens} max={LIMITS.maxTokens} aria-label={t("night.add.tokens")} value={tokens()} onInput={(e) => setTokens(e.currentTarget.value)} />
          </label>
        </div>
        <Show when={problem() && (prompt() || repoIds().length || role())}><p class="nq__note" data-tone="warn">{t(FORM_ERROR_KEY[problem()!])}</p></Show>
        <div class="nq__row">
          <Button variant="primary" icon={Plus} loading={busy()} disabled={!!problem()} onClick={() => void submit()}>{t("night.add.submit")}</Button>
          <Button variant="ghost" onClick={() => setShown(false)}>{t("night.add.cancel")}</Button>
        </div>
      </Show>
    </section>
  );
}

/** The evening view: prepare runs, set budgets, start the night. */
export default function QueueView() {
  const view = () => night();
  const items = () => view()?.items ?? [];
  const running = () => items().some((i) => i.state === "running");
  const queued = () => items().filter((i) => i.state === "queued").length;
  const finished = () => items().some((i) => i.state !== "queued" && i.state !== "running");
  const cap = () => view()?.cap ?? 8;
  const now = () => view()?.nowMs ?? Date.now();
  return (
    <div class="nq" data-armed={view()?.armed ? "" : undefined}>
      <section class="nq__card nq__head" aria-label={t("night.status")}>
        <div class="nq__headtext">
          <h2 class="nq__h"><Icon icon={Moon} size={16} /> {t("night.title")}</h2>
          <p class="nq__sub ui-tnum">{t("night.count", { n: items().length, cap: cap() })}</p>
        </div>
        <div class="nq__row">
          <Show when={running()}>
            <Button variant="danger" icon={Square} onClick={async () => { const e = await stopCurrent(); if (e) toast.error(t("night.toast.stopFailed"), e.message); }}>{t("night.stopRun")}</Button>
          </Show>
          <Show
            when={view()?.armed}
            fallback={
              <Button variant="primary" icon={Play} disabled={!queued()} onClick={async () => { const e = await arm(true); if (e) toast.error(t("night.toast.startFailed"), e.message); }}>{t("night.start")}</Button>
            }
          >
            <Button variant="secondary" icon={Pause} onClick={() => void arm(false)}>{t("night.pause")}</Button>
          </Show>
        </div>
      </section>

      <Show when={view()?.paused}>
        {(why) => (
          <div class="nq__banner" role="status" data-kind={why()}>
            <Icon icon={why() === "battery" ? Zap : Lock} size={16} />
            <span>{t(PAUSED_KEY[why()])}</span>
          </div>
        )}
      </Show>
      <Show when={view()?.armed && !view()?.paused && queued() > 0 && !running()}>
        <p class="nq__note">{t("night.armedHint")}</p>
      </Show>

      <Show when={items().length} fallback={<EmptyState size="sm" icon={Moon} title={t("night.empty.title")} description={t("night.empty.desc")} />}>
        <ol class="nq__list" aria-label={t("night.list.aria")}>
          <For each={items()}>{(item, i) => <ItemRow item={item} index={i()} last={i() === items().length - 1} now={now()} />}</For>
        </ol>
      </Show>

      <Show when={finished()}>
        <div class="nq__row">
          <Button variant="ghost" size="sm" onClick={() => void clearFinished()}>{t("night.clear")}</Button>
          <Show when={view()?.armed && queued() > 0}>
            <Button variant="ghost" size="sm" onClick={() => void arm(false, true)}>{t("night.cancelRest")}</Button>
          </Show>
        </div>
      </Show>

      <AddForm count={items().length} cap={cap()} />

      <p class="nq__safety"><Icon icon={ShieldCheck} size={14} /> {t("night.safety", { cap: cap() })}</p>
    </div>
  );
}
