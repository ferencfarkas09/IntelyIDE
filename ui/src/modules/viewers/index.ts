import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { openDockTab, registerDockTab } from "../../platform/dock";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { Braces, FileText, PanelRight } from "../../ui-kit";
import { activeDataFile, activePreviewFile, viewersEnabled } from "./state";

// Registry calls only: the engine, the worker and the renderers load with the first file that is opened.
const actions = () => import("./actions");

export function register(): void {
  registerTabType({ type: "jsonview", get title() { return t("viewers.tab.data"); }, icon: Braces, canClose: true, component: lazy(() => import("./JsonViewerTab")) });
  registerTabType({ type: "docview", get title() { return t("viewers.tab.preview"); }, icon: FileText, canClose: true, component: lazy(() => import("./PreviewTab")) });
  registerDockTab({ id: "viewer", get title() { return t("viewers.dock"); }, icon: PanelRight, component: lazy(() => import("./PreviewDock")) });
  registerOverlay({ id: "viewers", component: lazy(() => import("./ViewersWatcher")) });
  registerSettingsSection({ id: "viewers", get title() { return t("viewers.name"); }, order: 58, icon: Braces, searchTerms: ["json", "jsonl", "log", "markdown", "svg", "image", "png", "pdf", "preview", "tree"], component: lazy(() => import("./ViewersSettings")) });

  registerCommand({
    id: "viewers.openData",
    get title() {
      return t("viewers.cmd.data");
    },
    get group() {
      return t("viewers.name");
    },
    keywords: ["json", "jsonl", "ndjson", "log", "tree", "query", "jq"],
    when: () => viewersEnabled() && !!activeDataFile(),
    run: async () => {
      const f = activeDataFile();
      if (f) (await actions()).openDataViewer(f);
    },
  });
  registerCommand({
    id: "viewers.openPreview",
    get title() {
      return t("viewers.cmd.preview");
    },
    get group() {
      return t("viewers.name");
    },
    keywords: ["markdown", "svg", "image", "png", "jpg", "webp", "pdf"],
    when: () => viewersEnabled() && !!activePreviewFile(),
    run: async () => {
      const f = activePreviewFile();
      if (f) (await actions()).openPreview(f);
    },
  });
  registerCommand({
    id: "viewers.previewBeside",
    get title() {
      return t("viewers.cmd.beside");
    },
    get group() {
      return t("viewers.name");
    },
    keywords: ["split", "side", "markdown", "live"],
    when: () => viewersEnabled() && !!activePreviewFile(),
    run: () => openDockTab("viewer"),
  });
}
