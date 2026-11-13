import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { ConfirmOffer } from "../../store/agent-types";
import type { ErrorItem, PermissionItem, PlanCardItem, QuestionItem, ThinkingItem, TurnItem } from "../../store/agent-reducer";
import type { DelegateInfo, PermissionDecision, QuestionAnswer, SessionAllowKind, SessionAllowOffer, StopReason } from "../../store/agent-types";
import { Badge, Ban, Brain, Button, Check, ChevronRight, CircleAlert, CircleQuestionMark, Icon, Input, ListChecks, ShieldAlert, ShieldCheck, Spinner, TriangleAlert } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { errorWording, intentActor, RISK } from "./format";
import { isRoleRule, refusalHeadline } from "./refusal";
import { MODE_META, modeErrorText } from "./modes";
import "./modes.css";

/** In the order of the buttons: Deny comes first, so the choice that changes nothing is the nearest one; Allow once is the filled button. */
const DECISIONS: { id: PermissionDecision; label: MessageKey; variant: "primary" | "secondary"; title: MessageKey }[] = [
  { id: "deny", label: "chat.decision.deny", variant: "secondary", title: "chat.decision.denyTip" },
  { id: "allowOnce", label: "chat.decision.allowOnce", variant: "primary", title: "chat.decision.allowOnceTip" },
  // The session allow: what exactly it allows is the sentence above the buttons (`scopeSentence`), which is also this button's tooltip.
  { id: "allowRun", label: "modes.allowSession", variant: "secondary", title: "modes.allowSession" },
  { id: "allowAlways", label: "chat.decision.allowAlways", variant: "secondary", title: "chat.decision.allowAlwaysTip" },
];

const focused = new Set<string>();
const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/* ---- Typing guard -------------------------------------------------------------------------------------------------------------
 * A person who is typing a message must never lose the focus to a card: the next space or Enter would answer a request. Looking at
 * `document.activeElement` when the card arrives is not enough, because the composer can lose the focus without the person doing
 * anything: a `<Suspense>` above the run view that falls back for a moment takes its content out of the document and puts it back
 * (a lazy chip of the run list that is created again does that), and a field that leaves the document is blurred. So the composer
 * reports its focus here, and a blur nobody asked for is undone. */
let typing: { field: HTMLTextAreaElement; start: number; end: number; lost: boolean } | undefined;
let lastPointerDown = 0;
let pointerWatched = false;
const RESTORE_MS = [0, 16, 50, 120, 250, 500];

/** True while a composer draft is being typed: its field has (or just lost, without the person's doing) the focus and is not empty. */
export function personIsTyping(): boolean {
  if (typing && typing.field.value.trim() !== "") return true;
  const active = document.activeElement;
  return isTextField(active) && active.value.trim() !== "";
}

/**
 * WebKit does not send `blur` when the focused field leaves the document, so the loss can go unseen: before a card looks at the
 * focus, and before a key lands on the page body, the draft that was being typed gets its focus and caret back.
 */
function reclaimTyping(): void {
  const mine = typing;
  if (!mine || mine.field.value.trim() === "" || !mine.field.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  if (!mine.lost) {
    mine.start = mine.field.selectionStart;
    mine.end = mine.field.selectionEnd;
  }
  mine.field.focus({ preventScroll: true });
  if (document.activeElement !== mine.field) return;
  mine.field.setSelectionRange(mine.start, mine.end);
  mine.lost = false;
}

/**
 * The composer hands its field over: from then on a card never takes the focus while the field has it with a draft in it, and a
 * blur that came from the field leaving the document (not from a click, a Tab or a control taking the focus) is undone, caret
 * included. Returns the cleanup.
 */
export function trackTyping(field: HTMLTextAreaElement): () => void {
  if (!pointerWatched) {
    pointerWatched = true;
    document.addEventListener("pointerdown", () => (lastPointerDown = Date.now()), true);
    document.addEventListener("keydown", reclaimTyping, true);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mark = () => {
    clearTimeout(timer);
    typing = field.value.trim() !== "" ? { field, start: field.selectionStart, end: field.selectionEnd, lost: false } : typing?.field === field ? undefined : typing;
  };
  const restore = (i: number) => {
    const mine = typing;
    if (!mine || mine.field !== field || !mine.lost) return;
    const active = document.activeElement;
    // someone took the focus on purpose meanwhile (a dialog, another field): the draft is no longer being typed
    if (active && active !== document.body && active !== field) return void (typing = undefined);
    if (field.isConnected) {
      field.focus({ preventScroll: true });
      if (document.activeElement === field) {
        field.setSelectionRange(mine.start, mine.end);
        mine.lost = false;
        return;
      }
    }
    if (i + 1 < RESTORE_MS.length) timer = setTimeout(() => restore(i + 1), RESTORE_MS[i + 1] - RESTORE_MS[i]);
    else typing = undefined; // the composer is gone for good (another run, a closed pane)
  };
  const onBlur = (e: FocusEvent) => {
    if (typing?.field !== field) return;
    // The window lost the focus: the field is still the active element and gets the keys back with the window.
    if (document.activeElement === field) return;
    const meant = e.relatedTarget instanceof Element || Date.now() - lastPointerDown < 250 || field.value.trim() === "";
    if (meant) return void (typing = undefined);
    typing = { field, start: field.selectionStart, end: field.selectionEnd, lost: true };
    clearTimeout(timer);
    timer = setTimeout(() => restore(0), 0);
  };
  field.addEventListener("focus", mark);
  field.addEventListener("input", mark);
  field.addEventListener("blur", onBlur);
  if (document.activeElement === field) mark();
  return () => {
    clearTimeout(timer);
    field.removeEventListener("focus", mark);
    field.removeEventListener("input", mark);
    field.removeEventListener("blur", onBlur);
    if (typing?.field === field && !typing.lost) typing = undefined;
  };
}

/* ---- Geometry: what "on screen" means for a request ------------------------------------------------------------------------------ */
const EDGE = 1;
/** The margin a revealed card keeps from the edges of the transcript's viewport. The card itself is at most the viewport minus 16 px (`--perm-max`). */
const REVEAL_MARGIN = 6;

interface View {
  top: number;
  bottom: number;
  scroller?: HTMLElement;
}
/** The visible rectangle a card lives in: the client box of the transcript's scroller (the window where there is none). */
function viewOf(card: HTMLElement): View {
  const scroller = card.closest<HTMLElement>(".ui-scroll__viewport") ?? undefined;
  const windowBottom = window.innerHeight || document.documentElement.clientHeight;
  if (!scroller) return { top: 0, bottom: windowBottom };
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  return { top: Math.max(top, 0), bottom: Math.min(top + scroller.clientHeight, windowBottom), scroller };
}
const within = (el: Element, top: number, bottom: number) => {
  const r = el.getBoundingClientRect();
  return r.top >= top - EDGE && r.bottom <= bottom + EDGE;
};

/**
 * Real geometry, not scroll arithmetic: the card, its top block (title and what is asked) and its row of actions are all fully
 * inside the visible rectangle of the transcript, and so is the control that would take the focus (inside the card's own
 * scrolling middle too, when it sits there). A transcript with no height (a hidden pane) shows nothing.
 */
export function requestVisible(card: HTMLElement, target?: HTMLElement | null): boolean {
  if (!card.isConnected) return false;
  const view = viewOf(card);
  if (view.scroller && view.scroller.clientHeight <= 0) return false;
  const top = card.querySelector<HTMLElement>(".perm__top");
  const foot = card.querySelector<HTMLElement>(".perm__foot");
  if (!top || !foot) return false;
  const box = card.getBoundingClientRect();
  // the whole card, edges included (it is never taller than the viewport, see `--perm-max`) ...
  if (!within(card, view.top, view.bottom)) return false;
  // ... and, measured on their own, the two parts that must never be out of sight
  for (const el of [top, foot]) {
    // laid out at all (a real transcript never has a card without a height) ...
    if (view.scroller && el.getBoundingClientRect().height <= 0) return false;
    // ... inside the transcript's viewport, and not scrolled out of a card that had to scroll as a whole
    if (!within(el, view.top, view.bottom) || !within(el, box.top, box.bottom)) return false;
  }
  if (target) {
    if (!card.contains(target) || !within(target, view.top, view.bottom)) return false;
    const body = target.closest<HTMLElement>(".perm__body");
    if (body && card.contains(body)) {
      const b = body.getBoundingClientRect();
      if (!within(target, b.top, b.bottom)) return false;
    }
  }
  return true;
}

/** Tells the transcript that a request was scrolled into view, so that it stops pinning the end of the list over it. */
export const REVEAL_EVENT = "transcript:reveal";

/**
 * Brings a request into view: the WHOLE card inside the viewport of the transcript (a card is never taller than that, see
 * `--perm-max`), and the control that takes the focus inside the card's own scrolling middle. It only scrolls; whether the
 * card really is on screen afterwards is `requestVisible`'s business.
 */
export function revealRequest(card: HTMLElement, target?: HTMLElement | null): void {
  const view = viewOf(card);
  if (view.scroller) {
    const r = card.getBoundingClientRect();
    // nothing to bring into view in a pane that is hidden or a row that has no layout yet
    if (view.scroller.clientHeight <= 0 || r.height <= 0) return;
    let delta = 0;
    if (r.top < view.top + REVEAL_MARGIN) delta = r.top - view.top - REVEAL_MARGIN;
    else if (r.bottom > view.bottom - REVEAL_MARGIN) delta = Math.min(r.bottom - view.bottom + REVEAL_MARGIN, r.top - view.top - REVEAL_MARGIN);
    if (Math.abs(delta) >= 1) {
      view.scroller.scrollTop += delta;
      view.scroller.dispatchEvent(new CustomEvent(REVEAL_EVENT));
    }
  } else card.scrollIntoView?.({ block: "nearest" });
  const body = target?.closest<HTMLElement>(".perm__body");
  if (target && body && card.contains(body)) {
    const b = body.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (t.top < b.top) body.scrollTop += t.top - b.top;
    else if (t.bottom > b.bottom) body.scrollTop += Math.min(t.bottom - b.bottom, t.top - b.top);
  }
}

/* ---- Focus: only on a request that is on screen, and never straight under a key that is already on its way ---------------------- */
/** For this long after a card's control got the focus from the program, Enter and Space on the card's buttons do nothing. */
export const KEY_GUARD_MS = 600;
const guardedUntil = new WeakMap<HTMLElement, number>();
export const keyGuarded = (card: HTMLElement | undefined): boolean => !!card && Date.now() < (guardedUntil.get(card) ?? 0);
/** A click that a key made (Enter or Space on the button) while the card is still guarded; a pointer click always counts. */
export const keyClickTooSoon = (card: HTMLElement | undefined, e?: { detail?: number }): boolean => !!e && e.detail === 0 && keyGuarded(card);

const isActivation = (e: KeyboardEvent) => e.key === "Enter" || e.key === " " || e.key === "Spacebar";
const onButton = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest("button, [role='button'], [role='radio']");
/**
 * The key handlers of a request card. Enter and Space that arrive within `KEY_GUARD_MS` of the card taking the focus were
 * pressed for something else (the previous card, the composer): they are swallowed, key-up included, and so is a key that is
 * held down and repeats. Pointer clicks are not touched.
 */
export function guardKeys(card: () => HTMLElement | undefined): { down: (e: KeyboardEvent) => boolean; up: (e: KeyboardEvent) => void } {
  const swallowed = new Set<string>();
  const stop = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return {
    /** True when the key was swallowed. */
    down: (e) => {
      if (!isActivation(e) || !onButton(e)) return false;
      if (!e.repeat && !keyGuarded(card())) return false;
      swallowed.add(e.key);
      stop(e);
      return true;
    },
    up: (e) => {
      if (swallowed.delete(e.key) || (isActivation(e) && onButton(e) && keyGuarded(card()))) stop(e);
    },
  };
}

/** A control of a card the person is already working in (the second step of a stop and back): brought into view, then focused. */
export function focusInCard(card: HTMLElement | undefined, el: HTMLElement | null | undefined): void {
  if (!card?.isConnected || !el) return;
  revealRequest(card, el);
  el.focus({ preventScroll: true });
}

/** When the checks run after the first reveal: the transcript measures its rows and pins its end during the first few frames. */
const SETTLE_MS = [100, 250, 500, 900];
/** After the focus moved: the control that has it is looked at again, in case the list still moved under it. */
const RECHECK_MS = [250, 700];
let flight: { card: HTMLElement; cancel: () => void } | undefined;

/** May a card take the focus now? Not from a draft that is being typed, not from another open request, not from the rest of the app. */
function focusIsFree(card: HTMLElement): boolean {
  if (personIsTyping()) return false;
  const active = document.activeElement;
  if (!active || active === document.body || card.contains(active)) return true;
  const other = active.closest("section.perm");
  if (other && other !== card) return false;
  return !!active.closest(".chat");
}

/**
 * The one way a card's control gets the focus, for a new request and for the next one after an answer alike: reveal the whole
 * card, wait until the transcript has settled, check with real geometry that the top block, the actions and the control are on
 * screen, and only then focus (which starts the key guard). When that cannot be had (a pane that is too short, a card that is not
 * rendered), no button is focused: `otherwise` runs instead, and without it the focus stays where it is.
 */
function approach(card: HTMLElement, otherwise?: () => void): void {
  flight?.cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const mine = { card, cancel: () => ((cancelled = true), clearTimeout(timer)) };
  flight = mine;
  const done = () => {
    if (flight === mine) flight = undefined;
  };
  const giveUp = () => (done(), otherwise?.());
  const target = () => card.querySelector<HTMLElement>("[data-primary]");
  const watch = (i: number, el: HTMLElement) => {
    if (i >= RECHECK_MS.length) return done();
    timer = setTimeout(() => {
      if (cancelled || document.activeElement !== el) return done();
      if (!requestVisible(card, el)) {
        revealRequest(card, el);
        // still not on screen: a focused button nobody can see must not exist
        if (!requestVisible(card, el)) return done(), otherwise ? otherwise() : el.blur();
      }
      watch(i + 1, el);
    }, RECHECK_MS[i] - (RECHECK_MS[i - 1] ?? 0));
  };
  let seen = false;
  const step = (i: number) => {
    if (cancelled) return;
    const el = target();
    if (!card.isConnected || !el) return giveUp();
    if (!focusIsFree(card)) return done();
    if (requestVisible(card, el)) {
      // on screen twice in a row with nothing scrolled in between: settled
      if (seen) {
        guardedUntil.set(card, Date.now() + KEY_GUARD_MS);
        el.focus({ preventScroll: true });
        return watch(0, el);
      }
      seen = true;
    } else {
      seen = false;
      revealRequest(card, el);
      seen = requestVisible(card, el);
    }
    if (i >= SETTLE_MS.length) return giveUp();
    timer = setTimeout(() => step(i + 1), SETTLE_MS[i] - (SETTLE_MS[i - 1] ?? 0));
  };
  step(0);
}

/**
 * A new request takes focus once (rows are virtualised and remount while scrolling), unless you are typing or another request
 * already has the focus: then it waits. Focus on the page body or anywhere in the chat panel without a draft counts as "not typing".
 */
export function focusRequest(reqId: string, card: HTMLElement | undefined): void {
  if (!card?.isConnected || focused.has(reqId)) return;
  reclaimTyping();
  if (!focusIsFree(card)) return;
  // one request at a time: the first one that asked is being brought into view
  if (flight && flight.card !== card && flight.card.isConnected) return;
  focused.add(reqId);
  approach(card);
}

/** Runs `fn` once `el` is in the document (a `<Suspense>` above the run can take the whole view out for a moment). */
function whenAttached(el: HTMLElement, fn: () => void, i = 0): void {
  if (el.isConnected) return fn();
  if (i + 1 < RESTORE_MS.length) setTimeout(() => whenAttached(el, fn, i + 1), RESTORE_MS[i + 1] - RESTORE_MS[i]);
}

/**
 * After an answer, focus goes to the next open request (the same way a new one gets it: revealed, checked, then focused), else
 * back to the composer, so the next Tab does not restart at the top of the app. `toComposer` (Escape) skips the other requests.
 */
export function refocusAfterAnswer(card: HTMLElement | undefined, toComposer = false): void {
  if (!card?.contains(document.activeElement)) return;
  const root = card.closest<HTMLElement>(".chat");
  if (!root) return;
  flight?.cancel();
  const composer = () => root.querySelector<HTMLElement>(".composer textarea")?.focus({ preventScroll: true });
  // A timer, not a frame: a covered window gets no animation frames, and the focus must not wait for one.
  setTimeout(
    () =>
      whenAttached(root, () => {
        const next = toComposer ? undefined : [...root.querySelectorAll<HTMLElement>("section.perm")].find((c) => c !== card && !card.contains(c) && c.querySelector("[data-primary]"));
        if (next) approach(next, composer);
        else composer();
      }),
    0,
  );
}

/** True when the element's content is taller than its box (a clamped target line, a middle that scrolls). */
function watchOverflow(el: HTMLElement, set: (over: boolean) => void): void {
  if (typeof ResizeObserver === "undefined") return;
  const ro = new ResizeObserver(() => set(el.scrollHeight > el.clientHeight + 1));
  ro.observe(el);
  for (const child of el.children) ro.observe(child);
  onCleanup(() => ro.disconnect());
}
/** The pieces every request card shares: the element, whether its target line is cut and whether its middle scrolls. */
export function createCardState() {
  const [clipped, setClipped] = createSignal(false);
  const [scrolls, setScrolls] = createSignal(false);
  return { clipped, scrolls, target: (el: HTMLElement) => watchOverflow(el, setClipped), body: (el: HTMLElement) => watchOverflow(el, setScrolls) };
}

/** The last folder name of a path (the file a secret card is about, the repository it belongs to). */
const lastSegment = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** What a tier-2 card is about, in the words of the sentence: the file name for a file, the exact CLI reason for a prompt. */
export const stopWhat = (c: ConfirmOffer): string => (c.kind === "cliPrompt" ? c.scope : lastSegment(c.scope));
const stopVerb = (c: ConfirmOffer) => (c.kind === "secretFile" ? "read" : c.kind === "secretEdit" ? "edit" : "cli");

/** "You allowed reading .env once": the log line for a tier-2 card that was allowed, whether a card or a standing grant did it. */
export function stopDoneWording(p: { confirm?: ConfirmOffer; outcome?: string; grant?: string | null; by?: string }): string | undefined {
  if (!p.confirm || p.outcome !== "allow" || !p.grant) return undefined;
  // A standing run-wide grant that let one more file or prompt through: name what was used, "under the run-wide permission".
  if (p.grant === "run" && p.by === "saved") return t(`stops.done.${stopVerb(p.confirm)}.used` as MessageKey, { what: stopWhat(p.confirm) });
  // The card the person answered: a run-wide answer names the kind, never a file that was not on a card.
  if (p.grant === "run" && p.confirm.kind !== "cliPrompt") return t(`stops.done.${stopVerb(p.confirm)}.run` as MessageKey);
  return t(`stops.done.${stopVerb(p.confirm)}.${p.grant}` as MessageKey, { what: stopWhat(p.confirm) });
}

const DECISION_BY_YOU = { allowOnce: "chat.resolved.allowOnce", allowRun: "modes.resolved.allowSession", allowAlways: "chat.resolved.allowAlways", deny: "chat.resolved.denyYou" } as const satisfies Record<PermissionDecision, MessageKey>;
/** One sentence for a resolved request, worded by who decided. */
export function resolvedWording(p: Pick<PermissionItem, "outcome" | "by" | "decision" | "withdrawn"> & Partial<Pick<PermissionItem, "refusal">>): string {
  if (p.outcome === "cancelled") return t("chat.resolved.cancelled");
  if (p.withdrawn) return t("modes.resolved.withdrawn");
  const allowed = p.outcome === "allow";
  switch (p.by) {
    case "hardStop":
      // the CLI's own prompt that an unattended run cannot answer is not one of the IDE's hard stops
      if (p.refusal?.rule === "cli.prompt-denied") return t("chat.resolved.cliPrompt");
      return t("chat.resolved.hardStop");
    case "roleDeny":
      // the run's own rules (what Automatic judges inside the run's folders) are not the role's: say which one declined
      return t(p.refusal?.rule && !isRoleRule(p.refusal.rule) ? "chat.resolved.runDeny" : "chat.resolved.roleDeny");
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

const SCOPE_KEY = { exec: "modes.sessionAllow.exec", net: "modes.sessionAllow.net", mcp: "modes.sessionAllow.mcp", write: "modes.sessionAllow.write", peer: "modes.sessionAllow.peer" } as const satisfies Record<SessionAllowKind, MessageKey>;
const SCOPE_MARK = "\u0001";

/** What "allow always in this session" allows, as a sentence; the scope sits apart so the card can set it in code type. */
export function scopeSentence(offer: SessionAllowOffer): { before: string; scope?: string; after?: string; text: string } {
  const [before, after] = t(SCOPE_KEY[offer.kind], { scope: SCOPE_MARK }).split(SCOPE_MARK);
  return { before, ...(after === undefined ? {} : { scope: offer.scope, after }), text: t(SCOPE_KEY[offer.kind], { scope: offer.scope }) };
}

/** The tool of a run that asks to message another run of the same person; the target travels in `argv`. */
export const PEER_SEND_TOOL = "mcp__intely-peer__peer_send";

export function PermissionCard(props: { item: PermissionItem; onAnswer: (decision: PermissionDecision, extra?: { feedback?: string; confirmBroad?: boolean }) => void; /** The run's role table: marks a request from a role that comes from a repository. */ delegates?: DelegateInfo[]; /** The title of one of the person's runs (for the peer-message card). */ runTitle?: (id: string) => string | undefined }) {
  let card: HTMLElement | undefined;
  /** The delegate that asks, when one does (the lead has no actor). */
  const actor = () => intentActor(props.item.intent);
  const fromRepo = () => props.delegates?.find((d) => d.name === actor()?.role)?.scope === "repo";
  const risk = () => RISK[props.item.intent.class];
  const offered = () => DECISIONS.filter((d) => props.item.options.includes(d.id));
  /** A command or a write that cannot be allowed for the session (a script, a shell construct, a file that runs code) says so. */
  const onceOnly = () => !props.item.confirm && !props.item.options.includes("allowRun") && (props.item.intent.class === "exec" || props.item.intent.class === "write");
  const scope = () => (props.item.options.includes("allowRun") && props.item.sessionAllow ? scopeSentence(props.item.sessionAllow) : undefined);
  const scopeId = () => `perm-scope-${props.item.reqId}`;
  /** The command that will run: shown first and in full for a shell call. */
  const command = () => props.item.intent.rawCommand?.trim() || undefined;
  const said = () => agentWording(command(), props.item.intent.summary);
  /** The run a peer message would go to: its title when the list knows it, else its id. */
  const peerTarget = () => {
    if (props.item.intent.tool !== PEER_SEND_TOOL) return undefined;
    const id = props.item.intent.argv?.[0] ?? "";
    return id ? (props.runTitle?.(id) ?? id) : "?";
  };
  const paths = () => (props.item.intent.paths ?? []).filter((p) => !props.item.intent.summary.includes(p));
  const keys = guardKeys(() => card);
  const state = createCardState();
  const answer = (d: PermissionDecision, extra?: { feedback?: string; confirmBroad?: boolean }, toComposer = false) => {
    refocusAfterAnswer(card, toComposer); // before the answer: the card can leave the DOM as soon as it is sent
    if (extra) props.onAnswer(d, extra);
    else props.onAnswer(d);
  };
  // ---- tier 2: a stop the person may lift (secret file of the project, Claude CLI prompt) ----
  const stop = () => props.item.confirm;
  const [confirming, setConfirming] = createSignal(false);
  const [note, setNote] = createSignal("");
  const stopOffers = (id: PermissionDecision) => props.item.options.includes(id);
  /** A secret needs a second click for the run-wide choice (it covers every secret file of the run); a CLI reason does not. */
  const runIsBroad = () => stop()?.kind === "secretFile" || stop()?.kind === "secretEdit";
  /** The buttons of a stop, in the order of the row: Deny (the filled, focused default), Allow once, the run-wide choice. */
  const stopDecisions = () => (["deny", "allowOnce", "allowRun"] as const).filter(stopOffers);
  /** Into the second step and back: the focus goes to Cancel, and back to Deny; never to a button that allows. */
  const toStep = (on: boolean) => {
    setConfirming(on);
    queueMicrotask(() => focusInCard(card, card?.querySelector<HTMLElement>(on ? "[data-stop-cancel]" : "[data-primary]")));
  };
  const askRun = () => (runIsBroad() ? toStep(true) : answer("allowRun"));
  const denyStop = (toComposer = false) => answer("deny", note().trim() ? { feedback: note().trim() } : undefined, toComposer);
  /** The button a new request puts the focus on: Deny on a stop; else the first allow that is offered (Deny when nothing else is). */
  const primary = () => (stop() ? "deny" : (offered().find((d) => d.id !== "deny") ?? offered()[0])?.id);
  /** What is asked, in one piece: the line under the title shows its start, and all of it when it fits. */
  const summary = () => (actor() ? t("runs.actorAsks", { role: actor()!.role, summary: plain(props.item.intent.summary) }) : plain(props.item.intent.summary));
  const stopAsk = (c: ConfirmOffer) => t(`stops.ask.${c.kind}` as MessageKey, { what: stopWhat(c) });
  const asked = () => {
    const c = stop();
    if (c) return (actor() ? `${t("stops.who", { role: actor()!.role })}: ` : "") + stopAsk(c);
    const run = peerTarget();
    return command() ?? (run ? t("peer.card.ask", { run }) : summary());
  };
  const stopLabel = (d: "deny" | "allowOnce" | "allowRun", c: ConfirmOffer) => (d === "deny" ? t("stops.deny") : d === "allowOnce" ? t("stops.once") : t(`stops.run.${c.kind}` as MessageKey));
  const confirmId = () => `perm-confirm-${props.item.reqId}`;
  return (
    <Show
      when={!props.item.outcome}
      fallback={
        <div class="perm perm--done" data-outcome={props.item.outcome} role="status">
          <Icon icon={props.item.outcome === "allow" ? ShieldCheck : props.item.outcome === "deny" ? Ban : TriangleAlert} size={14} />
          <span class="perm__done-text">
            <Show when={actor()}>{(a) => <strong class="perm__actor">{a().role}: </strong>}</Show>
            <Show
              when={stopDoneWording(props.item)}
              fallback={
                <>
                  {resolvedWording(props.item)}{props.item.withdrawn ? " · " : ": "}
                  <span class="ui-mono">{props.item.intent.summary}</span>
                </>
              }
            >
              {(line) => <span data-testid="stop-done">{line()}</span>}
            </Show>
            <Show when={props.item.outcome === "deny" && props.item.refusal}>
              {(r) => (
                <span class="perm__why" title={r().reason}>
                  {refusalHeadline(r())}
                </span>
              )}
            </Show>
          </span>
        </div>
      }
    >
      {/* Three parts: the top (title and what is asked) and the foot (the buttons) never scroll, the middle does; the card is never
          taller than the transcript's viewport (`--perm-max`), so whenever the card is on screen all three are. */}
      <section
        ref={(el) => {
          card = el;
          requestAnimationFrame(() => focusRequest(props.item.reqId, el));
        }}
        class="perm"
        role="group"
        aria-label={stop() ? t("stops.title") : t("chat.perm.aria")}
        data-class={props.item.intent.class}
        data-stop={stop()?.kind}
        onKeyDown={(e) => {
          if (keys.down(e)) return;
          if (e.key !== "Escape") return;
          if (confirming()) {
            // Escape on the second confirmation backs out of it; it never allows anything
            e.preventDefault();
            e.stopPropagation();
            toStep(false);
          } else if (offered().some((d) => d.id === "deny")) {
            e.preventDefault();
            e.stopPropagation();
            if (stop()) denyStop(true);
            else answer("deny", undefined, true);
          }
        }}
        onKeyUp={keys.up}
      >
        <div class="perm__top">
          <header class="perm__head">
            <span class="perm__tile" aria-hidden="true">
              <Icon icon={ShieldAlert} size={16} />
            </span>
            <span class="perm__titles">
              <span class="perm__title">{stop() ? t("stops.title") : t("chat.perm.title")}</span>
              <span class="perm__explain">{risk().label}</span>
            </span>
            <Show when={actor()}>
              {(a) => (
                <Badge size="sm" tone={fromRepo() ? "warn" : "neutral"} title={fromRepo() ? t("roles.trust.fromRepo") : undefined}>
                  {a().role}
                  <Show when={fromRepo()}> · {t("roles.trust.fromRepoShort")}</Show>
                </Badge>
              )}
            </Show>
          </header>
          <Switch>
            <Match when={stop()}>
              {(c) => (
                <p class="perm__summary perm__stop-ask perm__target">
                  <span class="perm__clamp" ref={state.target} data-testid="stop-ask">
                    <Show when={actor()}>{(a) => <strong class="perm__actor">{t("stops.who", { role: a().role })}: </strong>}</Show>
                    {stopAsk(c())}
                  </span>
                </p>
              )}
            </Match>
            <Match when={command()}>
              {(c) => <pre class="perm__code perm__code--cmd perm__target ui-mono ui-selectable" aria-label={t("chat.perm.command")}><span class="perm__clamp" ref={state.target}>{c()}</span></pre>}
            </Match>
            <Match when={peerTarget()}>{(run) => <p class="perm__summary perm__target" data-testid="peer-ask"><span class="perm__clamp" ref={state.target}>{t("peer.card.ask", { run: run() })}</span></p>}</Match>
            <Match when={true}>
              <p class="perm__summary perm__target"><span class="perm__clamp" ref={state.target}>{summary()}</span></p>
            </Match>
          </Switch>
        </div>
        <div class="perm__body" ref={state.body} tabindex={state.scrolls() ? 0 : undefined} role={state.scrolls() ? "region" : undefined} aria-label={state.scrolls() ? t("chat.perm.details") : undefined}>
          <Show
            when={!confirming()}
            fallback={
              <Show when={stop()}>
                {(c) => (
                  <p class="perm__note perm__confirm-q" id={confirmId()} data-testid="stop-confirm">
                    {t(`stops.confirm.q.${c().kind}` as MessageKey)}
                  </p>
                )}
              </Show>
            }
          >
            {/* the line in the top was cut (a long path, a long command): all of it is here, where it can be scrolled and selected */}
            <Show when={state.clipped()}>
              <pre class="perm__code perm__full ui-mono ui-selectable" aria-label={t("chat.perm.full")}>{asked()}</pre>
            </Show>
            <Show when={stop()}>
              {(c) => (
                <>
                  <p class="perm__note" data-testid="stop-why">{t(`stops.why.${c().kind}` as MessageKey)}</p>
                  <Show when={c().kind !== "cliPrompt"}>
                    <p class="perm__code perm__stop-path ui-mono ui-selectable" title={c().scope} data-testid="stop-path">{c().scope}</p>
                  </Show>
                  <Show when={c().kind === "cliPrompt" && command()}>
                    {(cmd) => <pre class="perm__code perm__code--cmd ui-mono ui-selectable" aria-label={t("chat.perm.command")}>{cmd()}</pre>}
                  </Show>
                  <Show when={c().kind !== "cliPrompt" && stopOffers("allowRun")}>
                    <p class="perm__note" data-testid="stop-reach">{t(`stops.reach.${c().kind}` as MessageKey)}</p>
                  </Show>
                  <Show when={!stopOffers("allowOnce") && stopOffers("deny")}>
                    <p class="perm__note" role="note" data-testid="stop-phone">{t("stops.phone")}</p>
                  </Show>
                </>
              )}
            </Show>
            <Show when={!stop()}>
              <Show when={props.item.peer}>
                {(pc) => (
                  <div class="perm__peer" data-testid="peer-card" data-riskier={pc().riskier ? "" : undefined}>
                    <p class="perm__peer-who">{t("peer.card.target", { title: pc().title, where: pc().location, mode: t(MODE_META[pc().mode].label) })}</p>
                    <Show when={pc().riskier}>
                      <p class="perm__peer-warn" role="note">{t("peer.card.riskier")}</p>
                    </Show>
                    <pre class="perm__code ui-mono ui-selectable" aria-label={t("peer.card.text")}>{pc().text}</pre>
                  </div>
                )}
              </Show>
              <Show when={!peerTarget() && said()}>{(text) => <p class="perm__said">{t("chat.perm.said", { text: text() })}</p>}</Show>
              <Show when={paths().length}>
                <ul class="perm__paths ui-mono">
                  <For each={paths()}>{(p) => <li title={p}>{p}</li>}</For>
                </ul>
              </Show>
              <Show when={props.item.intent.url}>{(url) => <pre class="perm__code ui-mono ui-selectable">{url()}</pre>}</Show>
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
            </Show>
            <Show when={stop() && stopOffers("deny")}>
              <Input size="sm" aria-label={t("stops.note")} placeholder={t("stops.note")} value={note()} onInput={(e) => setNote(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); denyStop(); } }} />
            </Show>
          </Show>
        </div>
        <div class="perm__foot">
          <Switch>
            <Match when={stop() && confirming() ? stop() : undefined}>
              <div class="perm__actions perm__confirm" role="alertdialog" aria-labelledby={confirmId()}>
                <Button size="xl" variant="secondary" data-stop-cancel="" onClick={(e: MouseEvent) => keyClickTooSoon(card, e) || toStep(false)}>{t("stops.confirm.cancel")}</Button>
                <Button size="xl" variant="secondary" data-testid="stop-confirm-yes" aria-describedby={confirmId()} onClick={(e: MouseEvent) => keyClickTooSoon(card, e) || answer("allowRun", { confirmBroad: true })}>{t("stops.confirm.yes")}</Button>
              </div>
            </Match>
            <Match when={stop()}>
              {(c) => (
                <div class="perm__actions" data-testid="stop-actions">
                  <For each={stopDecisions()}>
                    {(d) => (
                      <Button
                        size="xl"
                        variant={d === "deny" ? "primary" : "secondary"}
                        class={d === "deny" ? "perm__deny" : undefined}
                        data-primary={d === "deny" ? "" : undefined}
                        data-testid={d === "allowRun" ? "stop-run" : undefined}
                        title={d === "deny" ? t("stops.denyTip") : undefined}
                        onClick={(e: MouseEvent) => keyClickTooSoon(card, e) || (d === "deny" ? denyStop() : d === "allowOnce" ? answer("allowOnce") : askRun())}
                      >
                        {stopLabel(d, c())}
                      </Button>
                    )}
                  </For>
                </div>
              )}
            </Match>
            <Match when={true}>
              <div class="perm__actions">
                <For each={offered()}>
                  {(d) => (
                    <Button
                      size="xl"
                      variant={d.variant}
                      class={d.id === "deny" ? "perm__deny" : undefined}
                      data-primary={d.id === primary() ? "" : undefined}
                      title={d.id === "deny" ? t("chat.withEsc", { tip: t(d.title) }) : d.id === "allowRun" && scope() ? scope()!.text : t(d.title)}
                      aria-describedby={d.id === "allowRun" && scope() ? scopeId() : undefined}
                      onClick={(e: MouseEvent) => keyClickTooSoon(card, e) || answer(d.id)}
                    >
                      {t(d.label)}
                    </Button>
                  )}
                </For>
              </div>
            </Match>
          </Switch>
          <Show when={props.item.error}>{(e) => <p class="perm__error" role="alert">{modeErrorText(e().code, e().message)}</p>}</Show>
        </div>
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
  const keys = guardKeys(() => card);
  const state = createCardState();
  const submit = (e?: MouseEvent) => {
    if (!canSend() || keyClickTooSoon(card, e)) return;
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
        onKeyDown={keys.down}
        onKeyUp={keys.up}
      >
        <div class="perm__top">
          <header class="perm__head">
            <span class="perm__tile" aria-hidden="true">
              <Icon icon={CircleQuestionMark} size={16} />
            </span>
            <span class="perm__titles">
              <span class="perm__title">{t("chat.q.title")}</span>
            </span>
          </header>
          <p class="perm__summary perm__target"><span class="perm__clamp" ref={state.target}>{props.item.prompt}</span></p>
        </div>
        <div class="perm__body" ref={state.body}>
          <Show when={state.clipped()}>
            <p class="perm__summary perm__full ui-selectable" aria-label={t("chat.perm.full")}>{props.item.prompt}</p>
          </Show>
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
                  onClick={(e: MouseEvent) => keyClickTooSoon(card, e) || toggle(o.id)}
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
        </div>
        <div class="perm__foot">
          <div class="perm__actions">
            <Button size="xl" variant="primary" disabled={!canSend()} onClick={(e: MouseEvent) => submit(e)}>
              {t("chat.q.send")}
            </Button>
          </div>
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
