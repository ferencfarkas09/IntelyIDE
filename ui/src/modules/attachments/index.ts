// Attachments module (alpha): drag-and-drop / paste / picker attachments for prompts, chats and agents.
// register() is cheap and synchronous: it installs the drop router, mounts the overlay and lightbox and registers the
// drop targets that are not composers (terminal, editor area, New Run fallback, ignored areas). Composers register
// themselves through `createComposerAttachments`. Design and limits: docs/attachments.md.
import { lazy } from "solid-js";
import { execute } from "../../platform/commands";
import { installDropRouter, registerDropTarget, type DropItem } from "../../platform/dropzone";
import { registerOverlay } from "../../platform/overlay";
import { toast } from "../../ui-kit";
import { t } from "../../i18n";
import { holdForNewRun } from "./newRunPrompt";
import { terminalTarget } from "./targets";
import { repos } from "../../store/workspace";
import { repoForPath } from "./store";

const pathItems = (items: readonly DropItem[]) => items.filter((i) => i.path);

export function register(): void {
  if (typeof window === "undefined") return;
  installDropRouter();
  registerOverlay({ id: "attachments.dropOverlay", component: lazy(() => import("./DropOverlay")) });
  registerOverlay({ id: "attachments.lightbox", component: lazy(() => import("./lightbox")) });

  registerDropTarget(terminalTarget());

  // The editor area opens a dropped file that lives in a registered repo as an editor tab.
  registerDropTarget({
    id: "editor.area",
    priority: 30,
    get label() {
      return t("attach.editorLabel");
    },
    get title() {
      return t("attach.editorDrop");
    },
    accepts: (items) => pathItems(items).length > 0,
    refusal: () => t("attach.editorRefusal"),
    isActive: () => !!document.querySelector(".etabs__panel"),
    element: () => document.querySelector<HTMLElement>(".etabs__panel"),
    onDrop: (items) => {
      const list = repos().map((r) => ({ id: r.id, path: r.path }));
      const outside: string[] = [];
      for (const i of pathItems(items)) {
        const hit = repoForPath(i.path!, list);
        if (hit && hit.rel) void execute("editor.openFile", { repoId: hit.repo.id, path: hit.rel });
        else outside.push(i.name);
      }
      if (outside.length) toast.error(t("attach.notOpened"), t("attach.outside", { names: outside.join(", ") }));
    },
  });

  // Fallback when no composer is visible: offer a new run with the files.
  registerDropTarget({
    id: "runs.newFromDrop",
    priority: 10,
    get label() {
      return t("attach.newRunLabel");
    },
    get title() {
      return t("attach.newRunDrop");
    },
    accepts: (items) => items.some((i) => i.kind === "file" || i.kind === "image"),
    isActive: () => true,
    onDrop: (items) => {
      holdForNewRun(items.filter((i) => i.kind === "file" || i.kind === "image"));
      void execute("runs.new");
    },
  });

  // Areas where a drop would do the wrong thing: say so quietly instead of attaching.
  const ignore = (id: string, selector: string, hint: () => string) =>
    registerDropTarget({ id, priority: 0, get label() { return hint(); }, ignores: true, get hint() { return hint(); }, accepts: () => false, onDrop: () => undefined, isActive: () => !!document.querySelector(selector), element: () => document.querySelector<HTMLElement>(selector) });
  ignore("commit.message", "textarea[data-commit-message]", () => t("attach.ignoreCommit"));
  ignore("changes.tree", '[data-testid="changes-tree"]', () => t("attach.ignoreTree"));
}
