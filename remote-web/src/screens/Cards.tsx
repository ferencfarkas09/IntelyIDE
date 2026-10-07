import { createMemo, createSignal, For, Show } from "solid-js";
import { Badge } from "@ui/ui-kit/Badge";
import { Button } from "@ui/ui-kit/Button";
import { Icon } from "@ui/ui-kit/Icon";
import { Spinner } from "@ui/ui-kit/Spinner";
import { Ban, CircleAlert, CircleQuestionMark, Lock, ShieldAlert, ShieldCheck, TriangleAlert } from "@ui/ui-kit/icons";
import { answerPermission, answerQuestion, canAnswer, runOf, state, type Card } from "../core/app";
import { visible } from "../core/wire";
import { now } from "../ui/clock";
import { go, runHref } from "../ui/nav";
import { countdown, tokens } from "../ui/format";
import { BottomSheet } from "../ui/BottomSheet";

const RISK = {
  low: { tone: "ok", label: "Low risk", icon: ShieldCheck },
  medium: { tone: "warn", label: "Medium risk", icon: TriangleAlert },
  high: { tone: "danger", label: "High risk", icon: ShieldAlert },
  blocked: { tone: "danger", label: "Blocked by policy", icon: Ban },
} as const;


/** Sentence from structured fields only (never model prose): "Wants to run a command". */
export function intentLine(c: Card): string {
  if (c.command || c.argv) return "Wants to run a command";
  if (c.url) return "Wants to reach a web address";
  if (c.paths.length) return "Wants to change files";
  return c.summary ? "Wants to use a tool" : "Needs permission";
}

export function Cards(props: { card: Card; showRun?: boolean }) {
  return props.card.kind === "question" ? <QuestionCard card={props.card} showRun={props.showRun} /> : <PermissionCard card={props.card} showRun={props.showRun} />;
}

function RunLine(props: { card: Card }) {
  const run = () => runOf(props.card.agentId);
  return (
    <Show when={run()}>
      {(r) => (
        <button type="button" class="card__run" onClick={() => go(runHref(r().agentId))} aria-label={`Open run ${r().title}`}>
          {r().title} <span class="muted">· {r().role}</span>
        </button>
      )}
    </Show>
  );
}

function Resolved(props: { card: Card }) {
  const r = () => props.card.resolution!;
  const where = () => (r().origin === "desktop" ? "on the Mac" : r().mine ? "from this phone" : "from another phone");
  const what = () => (props.card.kind === "question" && r().outcome === "allow" ? "Answered" : r().outcome === "allow" ? "Allowed" : r().outcome === "deny" ? "Denied" : "Cancelled");
  return (
    <p class="card__locked" data-testid="resolved">
      <Icon icon={Lock} size={14} /> {what()} {where()}
    </p>
  );
}

const viewOnlyNote = () =>
  state.capability === "view" ? "This device is view only. Allow replies for it on the Mac." : state.reauthRequired ? "Confirm with your passkey to reply." : "Not connected to the Mac. You can answer when it is back.";

export function PermissionCard(props: { card: Card; showRun?: boolean }) {
  const c = () => props.card;
  const risk = () => RISK[c().risk];
  const expired = createMemo(() => c().expiresAt > 0 && c().expiresAt <= now());
  const [more, setMore] = createSignal(false);
  const [full, setFull] = createSignal(false);
  const cmd = () => visible(c().command ?? (c().argv ? c().argv!.join(" ") : ""));
  const long = () => cmd().length > 280;
  const reply = () => canAnswer();
  const oneTap = () => c().eligibility === "low" && c().risk === "low" && reply();
  const stepUp = () => c().eligibility === "stepUp";
  const desktopOnly = () => c().eligibility === "desktopOnly" || c().risk === "blocked";

  return (
    <article class="card" data-kind="permission" data-risk={c().risk} data-testid="permission-card" aria-label="Permission request">
      <Show when={props.showRun}>
        <RunLine card={c()} />
      </Show>
      <header class="card__head">
        <Icon icon={risk().icon} size={20} />
        <h3>{intentLine(c())}</h3>
        <Badge tone={risk().tone} icon={risk().icon} size="sm">
          {risk().label}
        </Badge>
      </header>
      <Show when={cmd()}>
        <pre class="cmd" data-testid="command">
          <For each={tokens(full() || !long() ? cmd() : cmd().slice(0, 280) + "…")}>
            {(t) => (
              <>
                <span class={`tok tok--${t.cls}`}>{t.text}</span>{" "}
              </>
            )}
          </For>
        </pre>
        <Show when={long()}>
          <button type="button" class="link" onClick={() => setFull(!full())}>
            {full() ? "Show less" : "Show the whole command"}
          </button>
        </Show>
      </Show>
      <Show when={!cmd() && c().summary}>
        <p class="card__summary">{visible(c().summary)}</p>
      </Show>
      <Show when={c().paths.length}>
        <ul class="paths">
          <For each={c().paths.slice(0, 4)}>{(p) => <li>{visible(p)}</li>}</For>
        </ul>
      </Show>
      <Show when={c().url}>
        <p class="paths">{visible(c().url!)}</p>
      </Show>
      <Show when={c().reason && !c().resolution}>
        <p class="muted small">{c().reason}</p>
      </Show>

      <Show when={!c().resolution} fallback={<Resolved card={c()} />}>
        <Show
          when={!expired()}
          fallback={
            <p class="card__locked">
              <Icon icon={Lock} size={14} /> This request expired. Ask for it again from the run.
            </p>
          }
        >
          <Show when={desktopOnly()}>
            <p class="card__locked" data-testid="desktop-only">
              <Icon icon={Ban} size={14} /> {c().risk === "blocked" ? "Blocked by policy." : "Desktop only."} Answer this on your Mac.
            </p>
          </Show>
          <Show when={!reply() && !desktopOnly()}>
            <p class="card__locked" data-testid="view-only">
              <Icon icon={Lock} size={14} /> {viewOnlyNote()}
            </p>
          </Show>
          <Show when={!desktopOnly()}>
            <div class="card__actions">
              <Button size="lg" variant="secondary" disabled={!reply() || c().sending} onClick={() => void answerPermission(c().reqId, "deny")} data-testid="deny">
                Deny
              </Button>
              <Show when={oneTap()}>
                <Button size="lg" variant="primary" loading={c().sending} onClick={() => void answerPermission(c().reqId, "allowOnce")} data-testid="allow-once">
                  Allow once
                </Button>
              </Show>
              <Show when={stepUp() && reply()}>
                <Button size="lg" variant="primary" icon={Lock} onClick={() => setMore(true)} data-testid="allow-stepup">
                  Allow with passkey
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
        <p class="card__foot">
          <span class="muted small">{c().expiresAt > 0 ? countdown(c().expiresAt, now()) : ""}</span>
          <Show when={c().sending}>
            <span class="muted small">
              <Spinner size={12} /> Sending…
            </span>
          </Show>
        </p>
        <Show when={c().error}>
          <p class="problem" role="alert">
            <Icon icon={CircleAlert} size={14} /> {c().error}
          </p>
        </Show>
      </Show>
      <StepUpSheet open={more()} onClose={() => setMore(false)} card={c()} />
    </article>
  );
}

/** Step-up placeholder (remote-plan 4.1): the passkey assertion is bound to the request and checked on the Mac. Not wired yet. */
export function StepUpSheet(props: { open: boolean; onClose: () => void; card: Card }) {
  return (
    <BottomSheet open={props.open} onClose={props.onClose} title="Confirm with your passkey">
      <p>This action is not on the one-tap list, so the Mac wants a fresh passkey check (Face ID) from this phone, bound to this exact request.</p>
      <p class="muted small" data-testid="stepup-note">
        Passkey approval is not built into this version yet. Until then, answer this request on your Mac. You can still deny it here.
      </p>
      <div class="sheet__actions">
        <Button size="lg" variant="secondary" disabled>
          Use passkey (not available yet)
        </Button>
        <Button
          size="lg"
          variant="danger"
          onClick={() => {
            void answerPermission(props.card.reqId, "deny");
            props.onClose();
          }}
        >
          Deny
        </Button>
        <Button size="lg" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </BottomSheet>
  );
}

export function QuestionCard(props: { card: Card; showRun?: boolean }) {
  const c = () => props.card;
  const [picked, setPicked] = createSignal<string[]>([]);
  const [other, setOther] = createSignal(false);
  const [text, setText] = createSignal("");
  const reply = () => canAnswer();
  const longOptions = () => c().options.some((o) => o.length > 40);
  const toggle = (o: string) => setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]));
  const ready = () => (picked().length > 0 || (other() && text().trim().length > 0)) && reply() && !c().resolution && !c().sending;
  return (
    <article class="card" data-kind="question" data-testid="question-card" aria-label="Question">
      <Show when={props.showRun}>
        <RunLine card={c()} />
      </Show>
      <header class="card__head">
        <Icon icon={CircleQuestionMark} size={20} />
        <h3 data-testid="question-text">{visible(c().question ?? c().summary)}</h3>
      </header>
      <Show when={!c().resolution} fallback={<Resolved card={c()} />}>
        <div class={longOptions() ? "options options--list" : "options"} role="group" aria-label="Options">
          <For each={c().options}>
            {(o) => (
              <button type="button" class="chip" aria-pressed={picked().includes(o)} disabled={!reply()} onClick={() => toggle(o)}>
                {visible(o)}
              </button>
            )}
          </For>
          <button type="button" class="chip chip--ghost" aria-pressed={other()} disabled={!reply()} onClick={() => setOther(!other())}>
            Other…
          </button>
        </div>
        <Show when={other()}>
          <textarea class="text-input" rows={2} placeholder="Your answer" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        </Show>
        <Show when={!reply()}>
          <p class="card__locked" data-testid="view-only">
            <Icon icon={Lock} size={14} /> {viewOnlyNote()}
          </p>
        </Show>
        <div class="card__actions">
          <Button size="lg" variant="primary" disabled={!ready()} loading={c().sending} onClick={() => void answerQuestion(c().reqId, picked(), other() && text().trim() ? text().trim() : null)} data-testid="send-answer">
            Send
          </Button>
        </div>
        <Show when={c().error}>
          <p class="problem" role="alert">
            <Icon icon={CircleAlert} size={14} /> {c().error}
          </p>
        </Show>
      </Show>
    </article>
  );
}
