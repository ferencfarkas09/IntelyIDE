import { createResource, onCleanup, onMount, Show, type JSX } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Picked } from "../../ipc/picker";
import { execute } from "../../platform/commands";
import { dropState, registerDropTarget } from "../../platform/dropzone";
import { formatChord, shortcutFor } from "../../platform/keymap";
import { arrivedByClose, recents, registryProblem } from "../../store/workspaces";
import { BrandMark, FolderGit2, FolderOpen, FolderPlus, Icon, Kbd, Lock, Search, ShieldCheck, type LucideIcon } from "../../ui-kit";
import { openLink } from "../AboutCard";
import { handleDropped } from "./flows";
import { DOCS_URL, SAFETY_URL } from "./links";
import { CrashLoopNotice, ProblemCard } from "./ProblemCard";
import { RecentList } from "./RecentList";
import "./welcome.css";

interface ActionProps {
  icon: LucideIcon;
  title: string;
  hint: string;
  command: string;
  primary?: boolean;
  ref?: (el: HTMLButtonElement) => void;
}

/** A big action button: title, one line of explanation, and the chord read from the shortcut registry. */
function Action(props: ActionProps) {
  const chord = () => {
    const keys = shortcutFor(props.command);
    return keys ? formatChord(keys) : null;
  };
  return (
    <li>
      <button type="button" class="welcome__action" data-primary={props.primary ? "" : undefined} ref={props.ref} onClick={() => void execute(props.command)}>
        <span class="welcome__action-icon" aria-hidden="true">
          <Icon icon={props.icon} size={16} />
        </span>
        <span class="welcome__action-text">
          <span class="welcome__action-title">{props.title}</span>
          <span class="welcome__action-hint">{props.hint}</span>
        </span>
        <Show when={chord()}>{(keys) => <Kbd keys={keys()} />}</Show>
      </button>
    </li>
  );
}

function SafeCard(props: { jail: "off" | "readOnly" | "e2e" | undefined }) {
  return (
    <aside class="welcome__safe" aria-labelledby="welcome-safe-title">
      <h2 id="welcome-safe-title" class="welcome__safe-title">
        <Icon icon={ShieldCheck} size={16} />
        {t("welcome.safeTitle")}
      </h2>
      <p>{t("welcome.safeBody")}</p>
      <Show when={props.jail === "readOnly"}>
        <p class="welcome__mode" data-mode="readOnly">
          <Icon icon={Lock} size={14} />
          <span>{t("welcome.safeReadOnly")}</span>
        </p>
      </Show>
      <Show when={props.jail === "e2e"}>
        <p class="welcome__mode" data-mode="e2e">
          <Icon icon={Lock} size={14} />
          <span>{t("welcome.safeTestJail")}</span>
        </p>
      </Show>
    </aside>
  );
}

function Link(props: { href: string; children: JSX.Element }) {
  return (
    <a
      class="welcome__link"
      href={props.href}
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openLink(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

/**
 * The screen shown whenever no workspace is open (3.2). Replaces the whole shell body; the title bar stays. Everything it
 * offers is a command (`workspace.open`, `workspace.new`, `workspace.scan`), so the chord hints come from the registry.
 */
export function Welcome() {
  const [safety] = createResource(() => ipc.settings.safetyStatus().catch(() => null));
  let firstAction: HTMLButtonElement | undefined;

  onMount(() => {
    // Rust validates the dropped folders (picker:drop); the router target keeps the attachments from taking the same drop.
    const offTarget = registerDropTarget({
      id: "welcome.open",
      priority: 100,
      label: t("welcome.heading"),
      title: t("welcome.dropActive"),
      accepts: () => true,
      isActive: () => true,
      onDrop: () => undefined,
    });
    void ipc.picker.dropListen(true).catch(() => undefined);
    const offDrop = ipc.picker.onDrop(() => {
      void ipc.picker
        .takeDrop()
        .then((items: Picked[]) => handleDropped(items, (list) => void execute("workspace.new", { prefill: list })))
        .catch(() => undefined);
    });
    onCleanup(() => {
      offTarget();
      offDrop();
      void ipc.picker.dropListen(false).catch(() => undefined);
    });
    queueMicrotask(() => {
      if (arrivedByClose() && recents().length > 0) document.querySelector<HTMLElement>(".recent__main")?.focus();
      else firstAction?.focus();
    });
  });

  return (
    <main class="welcome" aria-labelledby="welcome-title" data-testid="welcome" data-dragging={dropState().active ? "" : undefined}>
      <div class="welcome__inner">
        <section class="welcome__start" aria-labelledby="welcome-title">
          <header class="welcome__hero">
            <BrandMark tile size={56} />
            <div class="welcome__hero-text">
              <h1 id="welcome-title" data-workspace-heading tabindex="-1">{t("welcome.heading")}</h1>
              <p class="welcome__tagline">{t("welcome.tagline")}</p>
            </div>
          </header>
          <ul class="welcome__actions" role="list">
            <Action icon={FolderOpen} title={t("welcome.open")} hint={t("welcome.openHint")} command="workspace.open" primary ref={(el) => (firstAction = el)} />
            <Action icon={FolderPlus} title={t("welcome.new")} hint={t("welcome.newHint")} command="workspace.new" />
            <Action icon={Search} title={t("welcome.scan")} hint={t("welcome.scanHint")} command="workspace.scan" />
          </ul>
          <SafeCard jail={safety()?.jail} />
          <p class="welcome__drop">
            <Icon icon={FolderGit2} size={14} />
            {t("welcome.drop")}
          </p>
        </section>
        <section class="welcome__recent" aria-labelledby="welcome-recent-title">
          <h2 id="welcome-recent-title" class="welcome__section-title">{t("welcome.recent")}</h2>
          <CrashLoopNotice />
          <ProblemCard />
          <RecentList hideEmpty={!!registryProblem()} />
          <nav class="welcome__links" aria-label={t("welcome.docs")}>
            <Link href={DOCS_URL}>{t("welcome.docs")}</Link>
            <Link href={SAFETY_URL}>{t("welcome.docsSafety")}</Link>
          </nav>
        </section>
      </div>
    </main>
  );
}
