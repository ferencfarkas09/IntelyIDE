import { createSignal, For, Show, type JSX } from "solid-js";
import { ipc } from "../ipc";
import { t } from "../i18n";
import { Badge, BrandMark, Check, Copy, ExternalLink, FolderGit2, GitGraph, Layers, Bot, Rewind, Sparkles, type LucideIcon } from "../ui-kit";
import { ABOUT, aboutCopy, aboutLicenseCopyright, type AboutIcon } from "./aboutText";
import { openLicenses } from "./licenses/open";

const ICONS: Record<AboutIcon, LucideIcon> = {
  repos: FolderGit2,
  agents: Bot,
  rewind: Rewind,
  git: GitGraph,
  workspace: Layers,
  light: Sparkles,
};

/** Opens an https link in the system browser (Rust refuses anything else); falls back to window.open in a plain browser. */
export function openLink(url: string) {
  if (!url.startsWith("https://")) return;
  if (window.__TAURI_INTERNALS__) void ipc.happy.openExternal(url).catch(() => undefined);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function AboutHero(props: { markSize?: number; variant?: "stacked" | "lockup" }) {
  const c = aboutCopy;
  return (
    <header class="about__hero">
      <BrandMark variant={props.variant ?? "stacked"} size={props.markSize ?? 132} label={ABOUT.product} />
      <h2 class="about__lead">{c().tagline}</h2>
      <p class="about__intro">{c().intro}</p>
    </header>
  );
}

export function AboutFeatures() {
  return (
    <ul class="about__features" aria-label={t("about.highlights")}>
      <For each={aboutCopy().features}>
        {(f) => {
          const Icon = ICONS[f.icon];
          return (
            <li class="about__feature">
              <span class="about__feature-icon" aria-hidden="true"><Icon size={16} strokeWidth={1.9} /></span>
              <span class="about__feature-body">
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </span>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

export interface SpecRow {
  label: string;
  value: JSX.Element | string;
  mono?: boolean;
  href?: string;
}

function SpecGroup(props: { title: string; rows: SpecRow[]; action?: JSX.Element; class?: string }) {
  return (
    <section class={props.class ? `about__specs ${props.class}` : "about__specs"} aria-label={props.title}>
      <div class="about__specs-head">
        <span>{props.title}</span>
        {props.action}
      </div>
      <dl class="about__rows">
        <For each={props.rows}>
          {(r) => (
            <div class="about__row">
              <dt class="about__row-label">{r.label}</dt>
              <dd class={`about__row-value${r.mono ? " about__row-value--mono" : ""}`}>
                <Show when={r.href} fallback={r.value}>
                  <button type="button" class="about__link" onClick={() => openLink(r.href!)}>
                    {r.value}
                    <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
                  </button>
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </section>
  );
}

/** The "spec sheet": who made it, where to find them, and what exactly is running. */
export function AboutSpecs(props: { build?: SpecRow[]; compact?: boolean }) {
  const l = () => aboutCopy().labels;
  const made = (): SpecRow[] =>
    props.compact
      ? [
          { label: l().author, value: ABOUT.author },
          { label: l().company, value: ABOUT.company },
          { label: l().github, value: "ferencfarkas09", href: ABOUT.github.author, mono: true },
          { label: l().github, value: "IntelyHome", href: ABOUT.github.company, mono: true },
        ]
      : [
          { label: l().author, value: ABOUT.author },
          { label: l().company, value: ABOUT.company },
          { label: l().githubAuthor, value: "github.com/ferencfarkas09", href: ABOUT.github.author, mono: true },
          { label: l().githubCompany, value: "github.com/IntelyHome", href: ABOUT.github.company, mono: true },
        ];
  const [copied, setCopied] = createSignal(false);
  const copyDetails = async () => {
    const lines = [
      `${ABOUT.product} (${ABOUT.company})`,
      ...(props.build ?? []).map((r) => `${r.label}: ${typeof r.value === "string" ? r.value : ""}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable (permissions); copying details is a convenience only.
    }
  };
  return (
    <div class="about__spec-stack">
      <SpecGroup title={l().madeBy} rows={made()} />
      <Show when={props.build?.length}>
        <SpecGroup
          title={l().build}
          rows={props.build!}
          action={
            <button type="button" class="about__copy" onClick={() => void copyDetails()} aria-live="polite">
              <Show when={copied()} fallback={<Copy size={12} strokeWidth={2} aria-hidden="true" />}>
                <Check size={12} strokeWidth={2.4} aria-hidden="true" />
              </Show>
              {copied() ? l().copied : l().copy}
            </button>
          }
        />
      </Show>
    </div>
  );
}

/** License card (GPLv3 section 5(d) notice), shared by the About dialog and Settings > About. Needs no async data. */
export function AboutLicense(props: { compact?: boolean }) {
  const l = () => aboutCopy().labels;
  const lic = () => aboutCopy().license;
  const rows = (): SpecRow[] => [
    {
      label: l().license,
      value: (
        <span class="about__license-id">
          <Badge tone="accent" class="about__chip">{ABOUT.license.id}</Badge>
          <button type="button" class="about__link" onClick={() => openLicenses({ select: "project" })}>{lic().view}</button>
        </span>
      ),
    },
    { label: l().copyright, value: aboutLicenseCopyright() },
    ...(ABOUT.source ? [{ label: l().source, value: new URL(ABOUT.source).hostname, href: ABOUT.source, mono: true }] : []),
  ];
  return (
    <div class={props.compact ? "about__license about__license--compact" : "about__license"}>
      <SpecGroup title={l().license} rows={rows()} />
      <div class="about__license-text">
        <p class="about__notice">{lic().notice}</p>
        <button type="button" class="about__link about__notice-link" onClick={() => openLink(ABOUT.license.url)}>
          {lic().online}
          <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
