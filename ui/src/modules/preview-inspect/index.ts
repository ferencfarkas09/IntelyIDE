import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";
import { inspecting, setInspecting } from "./state";

// Click-to-source for the embedded preview (docs/preview-inspect.md). The preview module marks its frame with
// `<iframe data-intely-preview data-repo-id=...>`; this module does the rest. Registry calls only.
export function register(): void {
  registerOverlay({ id: "preview-inspect", component: lazy(() => import("./PickerAndWatcher")) });
  registerCommand({
    id: "preview.inspect.toggle",
    get title() { return t("pvi.cmd.toggle"); },
    get group() { return t("pv.cmd.group"); },
    keywords: ["inspect", "click to source", "element", "react", "component"],
    run: () => void setInspecting(!inspecting()),
  });
}
