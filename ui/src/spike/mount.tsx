import { render } from "solid-js/web";
import { startHeartbeat } from "./heartbeat";
import { SpikeApp } from "./SpikeApp";
import "./styles.css";

/** Phase 0 measurement UIs, selected with INTELY_MODE=empty|rich. */
export function mountSpike(mode: "empty" | "rich", root: HTMLElement): void {
  render(() => <SpikeApp mode={mode} />, root);
  startHeartbeat();
}
