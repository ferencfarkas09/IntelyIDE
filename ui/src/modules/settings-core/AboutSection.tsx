import { createResource, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import { envStatus } from "../../store/workspace";
import { Badge, Button, CircleAlert, CircleCheck, FormGroup, FormRow, Info, RefreshCw, Spinner, TriangleAlert, type Tone } from "../../ui-kit";
import type { DoctorFinding, DoctorLevel } from "../../ipc/providers";
import { AboutFeatures, AboutHero, AboutLicense, AboutSpecs, type SpecRow } from "../../shell/AboutCard";
import { openLicenses } from "../../shell/licenses/open";
import { applyNotice, updateNotice } from "../updates/state";
import { loadAbout, webviewLabel } from "./about";
import DoctorChecks from "./DoctorChecks";
import "./settings-core.css";

const LEVEL: Record<DoctorLevel, { tone: Tone; icon: typeof Info; key: MessageKey }> = {
  ok: { tone: "ok", icon: CircleCheck, key: "aboutSection.level.ok" },
  info: { tone: "info", icon: Info, key: "aboutSection.level.info" },
  warn: { tone: "warn", icon: TriangleAlert, key: "aboutSection.level.warn" },
  error: { tone: "danger", icon: CircleAlert, key: "aboutSection.level.error" },
};

export default function AboutSection() {
  const [about] = createResource(loadAbout);
  const [report, { refetch }] = createResource<DoctorFinding[]>(() => ipc.providers.doctor().catch(() => []));
  const env = envStatus;
  if (!updateNotice()) void ipc.updates.status().then(applyNotice, () => undefined);
  const updateLine = () => {
    const n = updateNotice();
    const version = about()?.app ?? n?.currentVersion ?? "…";
    if (n?.state === "available") return t("updates.about.available", { version });
    return n?.state === "upToDate" ? t("updates.about.upToDate", { version }) : t("updates.about.unknown", { version });
  };
  const versions = (): SpecRow[] => [
    { label: "IntelyIDE", value: about()?.app ?? "…", mono: true },
    { label: t("updates.about.label"), value: updateLine() },
    { label: "Tauri", value: about()?.tauri ?? "—", mono: true },
    { label: "Webview", value: webviewLabel(about()?.webview ?? ""), mono: true },
    { label: "Git", value: env()?.gitPath ?? "—", mono: true },
    { label: "Node", value: env()?.nodePath ?? "—", mono: true },
  ];

  return (
    <div class="sc-section">
      <div class="about about--settings">
        <AboutHero variant="lockup" markSize={44} />
        <AboutFeatures />
        <AboutSpecs build={versions()} />
        <AboutLicense />
        <div class="about__license-actions">
          <Button size="sm" onClick={() => openLicenses()}>{t("about.licenses")}</Button>
        </div>
      </div>
      <FormGroup title={t("aboutSection.doctor")} description={t("aboutSection.doctorDesc")}>
        <FormRow label={t("aboutSection.report")} stacked>
          <div class="sc-doctor">
            <Show when={!report.loading} fallback={<Spinner size={14} />}>
              <ul class="sc-doctor__list" aria-label={t("aboutSection.reportAria")}>
                <For each={report()} fallback={<li class="sc-muted">{t("aboutSection.none")}</li>}>
                  {(f) => (
                    <li class="sc-doctor__item">
                      <Badge tone={LEVEL[f.level].tone} icon={LEVEL[f.level].icon}>{t(LEVEL[f.level].key)}</Badge>
                      <span class="sc-doctor__text">{f.provider ? <strong>{f.provider}</strong> : null} {f.message}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Button size="sm" icon={RefreshCw} onClick={() => void refetch()}>{t("aboutSection.runAgain")}</Button>
          </div>
        </FormRow>
      </FormGroup>
      <DoctorChecks extra={report()} />
    </div>
  );
}
