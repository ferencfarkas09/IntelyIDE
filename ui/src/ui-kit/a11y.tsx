import { createSignal, type JSX } from "solid-js";

export function VisuallyHidden(props: { children: JSX.Element; as?: "span" | "div" }) {
  return props.as === "div" ? <div class="ui-sr-only">{props.children}</div> : <span class="ui-sr-only">{props.children}</span>;
}

export type Politeness = "polite" | "assertive";

/** A live region whose text changes are announced by screen readers. */
export function LiveRegion(props: { message: string; politeness?: Politeness }) {
  return (
    <div class="ui-sr-only" role={props.politeness === "assertive" ? "alert" : "status"} aria-live={props.politeness ?? "polite"} aria-atomic="true">
      {props.message}
    </div>
  );
}

const [polite, setPolite] = createSignal("");
const [assertive, setAssertive] = createSignal("");
let clearTimer: ReturnType<typeof setTimeout> | undefined;

/** Announce a message app-wide. Mount <Announcer /> once near the root. */
export function announce(message: string, politeness: Politeness = "polite") {
  const set = politeness === "assertive" ? setAssertive : setPolite;
  // Clear first so repeating the same text is announced again.
  set("");
  queueMicrotask(() => set(message));
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    setPolite("");
    setAssertive("");
  }, 6000);
}

export function Announcer() {
  return (
    <>
      <LiveRegion message={polite()} />
      <LiveRegion message={assertive()} politeness="assertive" />
    </>
  );
}
