import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { ErrorItem, PermissionItem, PlanCardItem, QuestionItem, ThinkingItem, TurnItem } from "../../store/agent-reducer";
import type { DelegateInfo, PermissionDecision, QuestionAnswer, SessionAllowKind, SessionAllowOffer, StopReason } from "../../store/agent-types";
import { Badge, Ban, Brain, Button, Check, ChevronRight, CircleAlert, CircleQuestionMark, Icon, Input, ListChecks, ShieldAlert, ShieldCheck, Spinner, TriangleAlert } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { errorWording, intentActor, RISK } from "./format";
import { modeErrorText } from "./modes";
import "./modes.css";

const DECISIONS: { id: PermissionDecision; label: MessageKey; variant: "primary" | "secondary"; title: MessageKey }[] = [
  { id: "allowOnce", label: "chat.decision.allowOnce", variant: "primary", title: "chat.decision.allowOnceTip" },
  // The session allow: what exactly it allows is the sentence under the buttons (`scopeSentence`), which is also this button's tooltip.
  { id: "allowRun", label: "modes.allowSession", variant: "secondary", title: "modes.allowSession" },
  { id: "allowAlways", label: "chat.decision.allowAlways", variant: "secondary", title: "chat.decision.allowAlwaysTip" },
  { id: "deny", label: "chat.decision.deny", variant: "secondary", title: "chat.decision.denyTip" },
];

const focused = new Set<string>();
const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/**
 * A new request takes focus once (rows are virtualised and remount while scrolling), unless you are typing: then it waits.
 * Focus on the page body or anywhere in the chat panel without a draft counts as "not typing".
 */
export function focusRequest(reqId: string, card: HTMLElement | undefined): void {
  if (!card?.isConnected || focused.has(reqId)) return;
  const active = document.activeElement;
  const typing = isTextField(active) && active.value.trim() !== "";
  const free = !active || active === document.body || (!typing && !!active.closest(".chat"));
  if (!free) return;
  focused.add(reqId);
  card.querySelector<HTMLElement>("[data-primary]")?.focus({ preventScroll: true });
  card.scrollIntoView?.({ block: "nearest" });
}

/** After an answer, focus goes to the next open request, else back to the composer, so the next Tab does not restart at the top of the app. */
export function refocusAfterAnswer(card: HTMLElement | undefined): void {
  if (!card?.contains(document.activeElement)) return;
  const root = card.closest(".chat");
  // A timer, not a frame: a covered window gets no animation frames, and the focus must not wait for one.
  setTimeout(() => {
    const next = [...(root?.querySelectorAll<HTMLElement>(".perm [data-primary]") ?? [])].find((el) => !card.contains(el));
    (next ?? root?.querySelector<HTMLElement>(".composer textarea"))?.focus({ preventScroll: true });
  }, 0);
}

const DECISION_BY_YOU = { allowOnce: "chat.resolved.allowOnce", allowRun: "modes.resolved.allowSession", allowAlways: "chat.resolved.allowAlways", deny: "chat.resolved.denyYou" } as const satisfies Record<PermissionDecision, MessageKey>;
/** One sentence for a resolved request, worded by who decided. */
export function resolvedWording(p: Pick<PermissionItem, "outcome" | "by" | "decision" | "withdrawn">): string {
  if (p.outcome === "cancelled") return t("chat.resolved.cancelled");
  if (p.withdrawn) return t("modes.resolved.withdrawn");
  const allowed = p.outcome === "allow";
  switch (p.by) {
    case "hardStop":
      return t("chat.resolved.hardStop");
    case "roleDeny":
      return t("chat.resolved.roleDeny");
    case "failClosed":
      return t("chat.resolved.failClosed");
    case "saved":
      return t(allowed ? "chat.resolved.savedAllow" : "chat.resolved.savedDeny");
    default:
      return t(p.decision ? DECISION_BY_YOU[p.decision] : allowed ? "chat.resolved.allowYou" : "chat.resolved.denyYou");
  }
}

/** The summary names the command in backticks; plain text reads better in a sentence. */
const plain = (s: string) => s.replace(/`/g, "");
const squash = (s: string) => plain(s).replace(/\s+/g, " ").trim().replace(/…$/, "");

/**
 * For a shell command the summary is whatever description the model wrote, which the model (or a prompt injection in a
 * file it read) controls. The real command is the headline; the description is shown only as the agent's own words.
 * Returns undefined when the summary just repeats the command.
 */
export function agentWording(command: string | undefined, summary: string): string | undefined {
  if (!command) return undefined;
  const said = squash(summary);
  const cmd = squash(command);
  return !said || cmd.startsWith(said) || said.includes(cmd) ? undefined : plain(summary);
}

const SCOPE_KEY = { exec: "modes.sessionAllow.exec", net: "modes.sessionAllow.net", mcp: "modes.sessionAllow.mcp", write: "modes.sessionAllow.write" } as const satisfies Record<SessionAllowKind, MessageKey>;
const SCOPE_MARK = "\u0001";

/** What "allow always in this session" allows, as a sentence; the scope sits apart so the card can set it in code type. */
export function scopeSentence(offer: SessionAllowOffer): { before: string; scope?: string; after?: string; text: string } {
  const [before, after] = t(SCOPE_KEY[offer.kind], { scope: SCOPE_MARK }).split(SCOPE_MARK);
  return { before, ...(after === undefined ? {} : { scope: offer.scope, after }), text: t(SCOPE_KEY[offer.kind], { scope: offer.scope }) };
}

export function PermissionCard(props: { item: PermissionItem; onAnswer: (decision: PermissionDecision) => void; /** The run's role table: marks a request from a role that comes from a repository. */ delegates?: DelegateInfo[] }) {
  let card: HTMLElement | undefined;
  /** The delegate that asks, when one does (the lead has no actor). */
  const actor = () => intentActor(props.item.intent);
  const fromRepo = () => props.delegates?.find((d) => d.name === actor()?.role)?.scope === "repo";
  const risk = () => RISK[props.item.intent.class];
  const offered = () => DECISIONS.filter((d) => props.item.options.includes(d.id));
  /** A command or a write that cannot be allowed for the session (a script, a shell construct, a file that runs code) says so. */
  const onceOnly = () => !props.item.options.includes("allowRun") && (props.item.intent.class === "exec" || props.item.intent.class === "write");
  const scope = () => (props.item.options.includes("allowRun") && props.item.sessionAllow ? scopeSentence(props.item.sessionAllow) : undefined);
  const scopeId = () => `perm-scope-${props.item.reqId}`;
  /** The command that will run: shown first and in full for a shell call. */
  const command = () => props.item.intent.rawCommand?.trim() || undefined;
  const said = () => agentWording(command(), props.item.intent.summary);
  const paths = () => (props.item.intent.paths ?? []).filter((p) => !props.item.intent.summary.includes(p));
  const answer = (d: PermissionDecision) => {
    refocusAfterAnswer(card); // before the answer: the card can leave the DOM as soon as it is sent
    props.onAnswer(d);
  };
  const primary = () => offered()[0]?.id;
  return (
    <Show
      when={!props.item.outcome}
      fallback={
        <div class="perm perm--done" data-outcome={props.item.outcome} role="status">
          <Icon icon={props.item.outcome === "allow" ? ShieldCheck : props.item.outcome === "deny" ? Ban : TriangleAlert} size={14} />
          <span class="perm__done-text">
            <Show when={actor()}>{(a) => <strong class="perm__actor">{a().role}: </strong>}</Show>
            {resolvedWording(props.item)}{props.item.withdrawn ? " · " : ": "}
            <span class="ui-mono">{props.item.intent.summary}</span>
          </span>
        </div>
      }
    >
      <section
        ref={(el) => {
          card = el;
          requestAnimationFrame(() => focusRequest(props.item.reqId, el));
        }}
        class="perm"
        role="group"
        aria-label={t("chat.perm.aria")}
        data-class={props.item.intent.class}
        onKeyDown={(e) => {
          if (e.key === "Escape" && offered().some((d) => d.id === "deny")) {
            e.preventDefault();
            e.stopPropagation();
            answer("deny");
          }
        }}
      >
        <header class="perm__head">
          <Icon icon={ShieldAlert} size={14} />
          <span class="perm__title">{t("chat.perm.title")}</span>
          <Show when={actor()}>
            {(a) => (
              <Badge size="sm" tone={fromRepo() ? "warn" : "neutral"} title={fromRepo() ? t("roles.trust.fromRepo") : undefined}>
                {a().role}
                <Show when={fromRepo()}> · {t("roles.trust.fromRepoShort")}</Show>
              </Badge>
            )}
          </Show>
          <Badge tone={risk().tone} size="sm">
            {risk().label}
          </Badge>
        </header>
        <Show when={command()} fallback={<p class="perm__summary">{actor() ? t("runs.actorAsks", { role: actor()!.role, summary: plain(props.item.intent.summary) }) : plain(props.item.intent.summary)}</p>}>
          {(c) => <pre class="perm__code perm__code--cmd ui-mono ui-selectable" aria-label={t("chat.perm.command")}>{c()}</pre>}
        </Show>
        <Show when={said()}>{(text) => <p class="perm__said">{t("chat.perm.said", { text: text() })}</p>}</Show>
        <Show when={paths().length}>
          <ul class="perm__paths ui-mono">
            <For each={paths()}>{(p) => <li class="ui-truncate">{p}</li>}</For>
          </ul>
        </Show>
        <Show when={props.item.intent.url}>{(url) => <pre class="perm__code ui-mono ui-selectable">{url()}</pre>}</Show>
        <div class="perm__actions">
          <For each={offered()}>
            {(d) => (
              <Button
                size="sm"
                variant={d.variant}
                class={d.id === "deny" ? "perm__deny" : undefined}
                data-primary={d.id === primary() ? "" : undefined}
                title={d.id === "deny" ? t("chat.withEsc", { tip: t(d.title) }) : d.id === "allowRun" && scope() ? scope()!.text : t(d.title)}
                aria-describedby={d.id === "allowRun" && scope() ? scopeId() : undefined}
                onClick={() => answer(d.id)}
              >
                {t(d.label)}
              </Button>
            )}
          </For>
        </div>
        <Show when={scope()}>
          {(sc) => (
            <p class="perm__scope" id={scopeId()}>
              {sc().before}
              <Show when={sc().after !== undefined}>
                <code>{sc().scope}</code>
                {sc().after}
              </Show>
            </p>
          )}
        </Show>
        <Show when={onceOnly()}>
          <p class="perm__note">{t("modes.perm.onceOnly")}</p>
        </Show>
        <Show when={props.item.error}>{(e) => <p class="perm__error" role="alert">{modeErrorText(e().code, e().message)}</p>}</Show>
      </section>
    </Show>
  );
}

export function QuestionCard(props: { item: QuestionItem; onAnswer: (answer: QuestionAnswer) => void }) {
  let card: HTMLElement | undefined;
  const [picked, setPicked] = createSignal<string[]>([]);
  const [text, setText] = createSignal("");
  const toggle = (id: string) => setPicked((cur) => (props.item.multi ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));
  const canSend = () => picked().length > 0 || text().trim() !== "";
  const submit = () => {
    if (!canSend()) return;
    refocusAfterAnswer(card);
    props.onAnswer({ optionIds: picked(), text: text().trim() || undefined });
  };
  // A single choice is a radio group: one tab stop (the picked option, else the first), arrows move and pick.
  const tabbable = (id: string, i: number) => props.item.multi || (picked().length ? picked()[0] === id : i === 0);
  const onOptionKey = (e: KeyboardEvent, i: number) => {
    if (props.item.multi || !e.key.startsWith("Arrow")) return;
    const n = props.item.options.length;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + n) % n;
    setPicked([props.item.options[next].id]);
    card?.querySelectorAll<HTMLElement>(".q__option")[next]?.focus();
  };
  const answered = () => props.item.answer;
  const answerLabel = () => {
    const a = props.item.answer;
    if (!a) return "";
    const labels = a.optionIds.map((id) => props.item.options.find((o) => o.id === id)?.label ?? id);
    return [...labels, ...(a.text ? [a.text] : [])].join(", ");
  };
  return (
    <Show
      when={!answered() && !props.item.cancelled}
      fallback={
        <div class="perm perm--done" role="status">
          <Icon icon={CircleQuestionMark} size={14} />
          <span class="perm__done-text">
            {props.item.prompt} <strong>{props.item.cancelled ? t("chat.q.notAnswered") : answerLabel()}</strong>
          </span>
        </div>
      }
    >
      <section
        ref={(el) => {
          card = el;
          requestAnimationFrame(() => focusRequest(props.item.reqId, el));
        }}
        class="perm q"
        role="group"
        aria-label={t("chat.q.aria")}
      >
        <header class="perm__head">
          <Icon icon={CircleQuestionMark} size={14} />
          <span class="perm__title">{t("chat.q.title")}</span>
        </header>
        <p class="perm__summary">{props.item.prompt}</p>
        <div class="q__options" role={props.item.multi ? "group" : "radiogroup"} aria-label={t("chat.q.options")}>
          <For each={props.item.options}>
            {(o, i) => (
              <Button
                class="q__option"
                variant="secondary"
                size="md"
                role={props.item.multi ? undefined : "radio"}
                aria-checked={props.item.multi ? undefined : picked().includes(o.id)}
                aria-pressed={props.item.multi ? picked().includes(o.id) : undefined}
                tabIndex={tabbable(o.id, i()) ? 0 : -1}
                data-primary={i() === 0 ? "" : undefined}
                data-picked={picked().includes(o.id) ? "" : undefined}
                onClick={() => toggle(o.id)}
                onKeyDown={(e: KeyboardEvent) => onOptionKey(e, i())}
              >
                <span class="q__label">{o.label}</span>
                <Show when={o.description}>
                  <span class="q__desc">{o.description}</span>
                </Show>
              </Button>
            )}
          </For>
        </div>
        <Input size="sm" aria-label={t("chat.q.own")} placeholder={t("chat.q.own")} value={text()} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())} />
        <div class="perm__actions">
          <Button size="sm" variant="primary" disabled={!canSend()} onClick={submit}>
            {t("chat.q.send")}
          </Button>
        </div>
      </section>
    </Show>
  );
}

export function PlanCard(props: { item: PlanCardItem }) {
  const done = () => props.item.items.filter((i) => i.status === "done").length;
  return (
    <section class="plan" aria-label={t("chat.plan")}>
      <header class="plan__head">
        <Icon icon={ListChecks} size={14} />
        <span class="plan__title">{t("chat.plan")}</span>
        <span class="plan__count ui-tnum">
          {done()}/{props.item.items.length}
        </span>
      </header>
      <ol class="plan__list">
        <For each={props.item.items}>
          {(i) => (
            <li class="plan__item" data-status={i.status}>
              <span class="plan__mark" aria-hidden="true">
                <Switch>
                  <Match when={i.status === "done"}>
                    <Icon icon={Check} size={12} />
                  </Match>
                  <Match when={i.status === "inProgress"}>
                    <Spinner size={12} />
                  </Match>
                </Switch>
              </span>
              <span>{i.content}</span>
              <span class="ui-sr-only">{` (${t(i.status === "done" ? "chat.plan.done" : i.status === "inProgress" ? "chat.plan.inProgress" : "chat.plan.pending")})`}</span>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}

export function ThinkingBlock(props: { item: ThinkingItem }) {
  const [open, setOpen] = createSignal(false);
  const expanded = () => open() || !props.item.done;
  return (
    <div class="think" data-open={expanded() ? "" : undefined}>
      <button type="button" class="think__head" aria-expanded={expanded()} onClick={() => setOpen(!open())}>
        <span class="think__chev" data-open={expanded() ? "" : undefined}>
          <Icon icon={ChevronRight} size={12} />
        </span>
        <Icon icon={Brain} size={14} />
        <span>{props.item.done ? t("chat.thought") : t("chat.thinking")}</span>
      </button>
      <Show when={expanded()}>
        <p class="think__body ui-selectable">{props.item.text}</p>
      </Show>
    </div>
  );
}

export function ErrorCard(props: { item: ErrorItem; canRetry: boolean; onRetry: () => void }) {
  const wording = () => errorWording(props.item.class, props.item.message);
  return (
    <div class="banner" data-tone="danger" role="alert">
      <Icon icon={CircleAlert} size={14} />
      <div class="banner__text">
        <div class="banner__title">{wording().title}</div>
        <div class="banner__hint ui-selectable">{wording().hint}</div>
      </div>
      <Show when={props.canRetry && props.item.retryable}>
        <Button size="sm" variant="secondary" onClick={props.onRetry}>
          {t("chat.retry")}
        </Button>
      </Show>
    </div>
  );
}

const STOP_TEXT: Record<StopReason, MessageKey | undefined> = {
  endTurn: undefined,
  cancelled: "chat.stop.cancelled",
  maxTurns: "chat.stop.maxTurns",
  maxTokens: "chat.stop.maxTokens",
  refusal: "chat.stop.refusal",
  error: "chat.stop.error",
};

/** What the Continue button of the step-limit row sends: a plain new turn of the same run. */
export const CONTINUE_TEXT = "Continue";

export function TurnMarker(props: { item: TurnItem; /** The run is idle and this is its last row: Continue makes sense. */ canContinue?: boolean; onContinue?: () => void }) {
  return (
    <Show when={props.item.stopReason === "maxTurns"} fallback={<PlainTurnMarker item={props.item} />}>
      <div class="banner" data-tone="warn" role="status" data-testid="step-limit">
        <Icon icon={CircleAlert} size={14} />
        <div class="banner__text">
          <div class="banner__title">{props.item.steps ? t("memory.stepLimit", { n: props.item.steps }) : t("memory.stepLimit.unknown")}</div>
        </div>
        <Show when={props.canContinue && props.onContinue}>
          <Button size="sm" variant="secondary" onClick={() => props.onContinue?.()}>
            {t("memory.stepLimit.continue")}
          </Button>
        </Show>
      </div>
    </Show>
  );
}

function PlainTurnMarker(props: { item: TurnItem }) {
  return (
    <div class="turn-mark" role="status">
      <span class="turn-mark__rule" />
      <span>{STOP_TEXT[props.item.stopReason] ? t(STOP_TEXT[props.item.stopReason]!) : undefined}</span>
      <span class="turn-mark__rule" />
    </div>
  );
}
