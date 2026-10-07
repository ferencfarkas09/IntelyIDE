import { lazy, Show, type Component } from "solid-js";
import { licensesState } from "./open";

// The dialog (L3b) is a separate chunk found by glob, so the host works before it exists and costs nothing until first open.
const dialogs = import.meta.glob<{ default: Component }>("./LicensesDialog.tsx");
const Dialog = lazy(async () => {
  const load = dialogs["./LicensesDialog.tsx"];
  return load ? load() : { default: (() => null) as Component };
});

/** Mounted once as an overlay. Renders nothing until `openLicenses()` was called for the first time. */
export default function LicensesHost() {
  return (
    <Show when={licensesState().ever}>
      <Dialog />
    </Show>
  );
}
