import { createRoot, createSignal } from "solid-js";

/** One shared one-second ticker for countdowns and "recently answered" windows. */
export const now = createRoot(() => {
  const [now, setNow] = createSignal(Date.now());
  setInterval(() => setNow(Date.now()), 1000);
  return now;
});
