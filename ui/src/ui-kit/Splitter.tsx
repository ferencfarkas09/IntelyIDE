import { t } from "../i18n";
import { createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";
import { clampSize, effectiveMax, keyboardSize, loadSplitterSize, saveSplitterSize } from "./splitter-logic";

export interface SplitterProps {
  /** "row": panes side by side (vertical handle). "column": stacked panes (horizontal handle). */
  direction?: "row" | "column";
  first: JSX.Element;
  second: JSX.Element;
  /** Which pane has the fixed pixel size; the other one flexes. */
  primary?: "first" | "second";
  /** Initial size of the primary pane in px (used when nothing is persisted). */
  defaultSize: number;
  min?: number;
  max?: number;
  /** Space always left for the flexing pane. */
  minOther?: number;
  /** Persisted under intely.splitter.<storageKey>. */
  storageKey?: string;
  label?: string;
  /**
   * Hides the primary pane and the handle; the other pane takes the whole area and stays mounted (the same DOM node),
   * so toggling a side panel does not reset the state of what is next to it.
   */
  collapsed?: boolean;
  onResize?: (size: number) => void;
  class?: string;
}

const HANDLE = 1;

export function Splitter(props: SplitterProps) {
  const row = () => (props.direction ?? "row") === "row";
  const primaryFirst = () => (props.primary ?? "first") === "first";
  const min = () => props.min ?? 160;
  const max = () => props.max ?? 960;
  const paneId = createUniqueId();

  const [size, setSize] = createSignal(loadSplitterSize(props.storageKey, props.defaultSize, min(), max()));
  const [container, setContainer] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  let root!: HTMLDivElement;

  const hi = () => effectiveMax(max(), container(), props.minOther ?? 240, HANDLE);
  const shown = () => clampSize(size(), min(), hi());
  const commit = (next: number, persist: boolean) => {
    const v = clampSize(next, min(), hi());
    setSize(v);
    props.onResize?.(v);
    if (persist) saveSplitterSize(props.storageKey, v);
  };

  onMount(() => {
    const ro = new ResizeObserver(() => setContainer(row() ? root.clientWidth : root.clientHeight));
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });

  let startPos = 0;
  let startSize = 0;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startPos = row() ? e.clientX : e.clientY;
    startSize = shown();
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging()) return;
    const delta = (row() ? e.clientX : e.clientY) - startPos;
    commit(startSize + (primaryFirst() ? delta : -delta), false);
  };
  const endDrag = (e: PointerEvent) => {
    if (!dragging()) return;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    saveSplitterSize(props.storageKey, shown());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(props.defaultSize, true);
      return;
    }
    // Arrow keys along the handle's own axis only.
    const along = row() ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (e.key.startsWith("Arrow") && !along.includes(e.key)) return;
    const next = keyboardSize(shown(), e.key, e.shiftKey, min(), hi(), primaryFirst() ? "forward" : "backward");
    if (next === null) return;
    e.preventDefault();
    commit(next, true);
  };

  const paneStyle = (isPrimary: boolean): JSX.CSSProperties =>
    isPrimary ? { flex: `0 0 ${shown()}px`, [row() ? "width" : "height"]: `${shown()}px` } : { flex: "1 1 0" };

  const handle = () => (
    <div
      class="ui-splitter__handle"
      role="separator"
      tabIndex={0}
      aria-label={props.label ?? t("kit.resizePanel")}
      aria-orientation={row() ? "vertical" : "horizontal"}
      aria-controls={`${paneId}-${primaryFirst() ? "first" : "second"}`}
      aria-valuemin={min()}
      aria-valuemax={Math.round(hi())}
      aria-valuenow={Math.round(shown())}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDblClick={() => commit(props.defaultSize, true)}
      onKeyDown={onKeyDown}
    />
  );

  return (
    <div ref={root} class={props.class ? `ui-splitter ${props.class}` : "ui-splitter"} data-direction={props.direction ?? "row"} data-dragging={dragging() ? "" : undefined} data-collapsed={props.collapsed ? "" : undefined}>
      <Show when={!(props.collapsed && primaryFirst())}>
        <div class="ui-splitter__pane" id={`${paneId}-first`} style={paneStyle(primaryFirst())}>
          {props.first}
        </div>
      </Show>
      <Show when={!props.collapsed}>{handle()}</Show>
      <Show when={!(props.collapsed && !primaryFirst())}>
        <div class="ui-splitter__pane" id={`${paneId}-second`} style={paneStyle(!primaryFirst())}>
          {props.second}
        </div>
      </Show>
    </div>
  );
}
