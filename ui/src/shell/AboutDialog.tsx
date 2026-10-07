import { createEffect, createResource, createSignal, Show } from "solid-js";
import { Button, Dialog } from "../ui-kit";
import { t } from "../i18n";
import { AboutFeatures, AboutHero, AboutLicense, AboutSpecs, type SpecRow } from "./AboutCard";
import { ABOUT, aboutCopy } from "./aboutText";
import { licensesState, openLicenses } from "./licenses/open";

const [open, setOpen] = createSignal(false);
export const openAbout = () => setOpen(true);

interface BuildInfo {
  version: string;
  runtime: string;
}

async function loadBuildInfo(): Promise<BuildInfo> {
  if (!window.__TAURI_INTERNALS__) return { version: "dev", runtime: "" };
  const { getTauriVersion, getVersion } = await import("@tauri-apps/api/app");
  const [version, tauri] = await Promise.all([getVersion(), getTauriVersion()]);
  return { version, runtime: `Tauri ${tauri}` };
}

export function AboutDialog() {
  const [info] = createResource(loadBuildInfo);
  const build = (): SpecRow[] => {
    const l = aboutCopy().labels;
    return [
      { label: l.version, value: info()?.version ?? "…", mono: true },
      { label: l.kind, value: import.meta.env.DEV ? l.development : l.release },
      { label: l.runtime, value: info() ? info()!.runtime || t("about.browserRuntime") : "…", mono: !!info()?.runtime },
    ];
  };
  // The licenses view replaces About instead of stacking on top of it.
  createEffect(() => {
    if (licensesState().open) setOpen(false);
  });
  return (
    <Dialog open={open()} onClose={() => setOpen(false)} title={t("about.title", { product: ABOUT.product })} size="lg" footer={
        <>
          <Button variant="ghost" onClick={() => openLicenses()}>{t("about.licenses")}</Button>
          <Button variant="secondary" data-autofocus onClick={() => setOpen(false)}>{t("about.close")}</Button>
        </>
      }>
      <div class="about about--compact">
        <AboutHero variant="lockup" markSize={40} />
        <AboutFeatures />
        <AboutSpecs compact build={build()} />
        <AboutLicense compact />
        <Show when={info.error}>
          <p class="about__note">{t("about.buildUnavailable")}</p>
        </Show>
      </div>
    </Dialog>
  );
}
