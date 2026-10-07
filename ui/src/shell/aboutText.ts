/** Texts shared by the About dialog (title-bar logo) and Settings > About, so the two never drift apart.
 *  The wording lives in the i18n catalog (`locales/<lang>/about.json`); `aboutCopy()` reads it for the active language. */
import { t } from "../i18n";

export type AboutIcon = "repos" | "agents" | "rewind" | "git" | "workspace" | "light";

export interface AboutCopy {
  tagline: string;
  intro: string;
  features: { icon: AboutIcon; title: string; text: string }[];
  labels: {
    madeBy: string;
    author: string;
    company: string;
    github: string;
    githubAuthor: string;
    githubCompany: string;
    build: string;
    version: string;
    kind: string;
    runtime: string;
    copy: string;
    copied: string;
    development: string;
    release: string;
    license: string;
    copyright: string;
    source: string;
  };
  license: { notice: string; view: string; online: string; viewAll: string };
}

const FEATURES = ["repos", "agents", "rewind", "git", "workspace", "light"] as const satisfies readonly AboutIcon[];

export const ABOUT = {
  product: "IntelyIDE",
  author: "Ferenc Farkas",
  company: "IntelyHome",
  year: "2026",
  /** The copyright holder line (D1); the same text is in REUSE.toml and the notices. */
  holder: "Ferenc Farkas (IntelyHome) and IntelyIDE contributors",
  /** GPL-3.0-or-later: GPL v3 or, at the recipient's option, any later version of the GPL. */
  license: {
    id: "GPL-3.0-or-later",
    url: "https://www.gnu.org/licenses/gpl-3.0.html",
  },
  /** Public source URL (D7, decided 2026-10-04). Change it here only; the licence tooling reads scripts/licenses/policy.json. */
  source: "https://github.com/ferencfarkas09/IntelyIDE" as string | undefined,
  github: {
    author: "https://github.com/ferencfarkas09",
    company: "https://github.com/IntelyHome",
  },
} as const;

export const ABOUT_LINKS = [
  { label: "GitHub: ferencfarkas09", href: ABOUT.github.author },
  { label: "GitHub: IntelyHome", href: ABOUT.github.company },
] as const;

/** Reactive: reads the language signal through `t`. */
export const aboutCopy = (): AboutCopy => ({
  tagline: t("about.tagline"),
  intro: t("about.intro"),
  features: FEATURES.map((icon) => ({ icon, title: t(`about.feature.${icon}.title`), text: t(`about.feature.${icon}.text`) })),
  labels: {
    madeBy: t("about.label.madeBy"),
    author: t("about.label.author"),
    company: t("about.label.company"),
    github: t("about.label.github"),
    githubAuthor: t("about.label.githubAuthor"),
    githubCompany: t("about.label.githubCompany"),
    build: t("about.label.build"),
    version: t("about.label.version"),
    kind: t("about.label.kind"),
    runtime: t("about.label.runtime"),
    copy: t("about.label.copy"),
    copied: t("about.label.copied"),
    development: t("about.label.development"),
    release: t("about.label.release"),
    license: t("about.label.license"),
    copyright: t("about.label.copyright"),
    source: t("about.label.source"),
  },
  license: {
    notice: t("about.licenseNotice", { product: ABOUT.product }),
    view: t("about.license.view"),
    online: t("about.license.online"),
    viewAll: t("about.licenses"),
  },
});

/** The only copyright line in the UI (licensing spec gate 5: one holder line everywhere); the License card renders it. */
export const aboutLicenseCopyright = () => `© ${ABOUT.year} ${ABOUT.holder}`;
