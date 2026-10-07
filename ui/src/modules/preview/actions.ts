// What the palette, the dock and the views share: opening a preview, setting its address, mapping a file to a page.
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { activeTab, openTab } from "../../platform/tabs";
import { repoConfig, repos } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { KIND_PORT, pageForFile, type PageEntry, type PageMatch } from "./catalog";
import { routeUrl, validatePreviewUrl, type UrlCheck } from "./logic";
import { catalogOf, dockRepoId, loadRepoState, patchRepoState, refreshCatalog, repoState } from "./state";

export const previewTabId = (repoId: string) => `preview:${repoId}`;

/** Where the repo's dev server is expected: the saved address, else the kind's default port. */
export function currentUrl(repoId: string): string {
  const saved = repoState(repoId).url;
  if (saved) return saved;
  const c = catalogOf(repoId);
  const kind = c && c !== "loading" ? c.kind : "unknown";
  return kind === "unknown" ? "" : `http://localhost:${KIND_PORT[kind]}/`;
}

const originOf = (url: string): string | undefined => {
  const r = validatePreviewUrl(url);
  return r.ok ? r.origin : undefined;
};

/** UI check first, then the Rust gate; only a string both accepted is stored (and so loaded). */
export async function setPreviewUrl(repoId: string, input: string): Promise<UrlCheck> {
  const local = validatePreviewUrl(input, globalThis.location?.origin);
  if (!local.ok) return local;
  try {
    const target = await ipc.preview.checkUrl(local.url);
    patchRepoState(repoId, { url: target.url });
    return { ok: true, url: target.url, host: target.host, port: target.port, origin: target.origin };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, reason: (err.code as never) ?? "notLoopback", message: err.message ?? t("pv.url.refused") };
  }
}

export async function openPreviewTab(repoId: string): Promise<void> {
  await loadRepoState(repoId);
  void refreshCatalog(repoId);
  openTab({ type: "preview", id: previewTabId(repoId), title: t("pv.tab", { name: repoConfig(repoId)?.name ?? repoId }), params: { repoId } });
}

/** The page a quick-list entry opens: the server origin we have, plus the route. */
export function urlForPage(repoId: string, page: PageEntry): string {
  const origin = originOf(currentUrl(repoId));
  return origin ? (page.deepLink ? routeUrl(origin, page.link) : `${origin}/`) : "";
}

export async function openPage(repoId: string, page: PageEntry): Promise<UrlCheck | undefined> {
  if (page.params.length > 0) return undefined; // a dynamic route needs a real id: type it in the address bar
  const url = urlForPage(repoId, page);
  return url ? setPreviewUrl(repoId, url) : undefined;
}

/** The open editor file, as repo and path. */
export function activeFile(): { repoId: string; path: string } | undefined {
  const t = activeTab();
  const repoId = t?.type === "file" ? (t.params?.repoId as string | undefined) : undefined;
  const path = t?.type === "file" ? (t.params?.path as string | undefined) : undefined;
  return repoId && path ? { repoId, path } : undefined;
}

export async function pageForActiveFile(): Promise<{ repoId: string; match: PageMatch } | undefined> {
  const f = activeFile();
  if (!f) return undefined;
  const catalog = await refreshCatalog(f.repoId);
  const match = catalog && pageForFile(catalog.pages, f.path);
  return match ? { repoId: f.repoId, match } : undefined;
}

/** Palette command: opens the preview on the page of the file in the editor. */
export async function openPreviewForFile(): Promise<void> {
  const f = activeFile();
  if (!f) return void toast.info(t("pv.toast.needFile"), t("pv.toast.needFileBody"));
  const found = await pageForActiveFile();
  if (!found) return void toast.info(t("pv.toast.noPage"), t("pv.toast.noPageBody"));
  await openPreviewTab(f.repoId);
  const r = await openPage(f.repoId, found.match.page);
  if (r === undefined) toast.info(t("pv.toast.needsId", { name: found.match.page.name }), t("pv.toast.needsIdBody", { link: found.match.page.link }));
  else if (!r.ok) toast.error(t("pv.toast.openFailed"), r.message);
  else if (!found.match.page.deepLink) toast.info(t("pv.toast.expoNone"), t("pv.toast.expoNoneBody"));
}

export async function openPreviewForDefaultRepo(): Promise<void> {
  const f = activeFile();
  const repoId = f?.repoId ?? dockRepoId() ?? repos()[0]?.id;
  if (repoId) await openPreviewTab(repoId);
}

