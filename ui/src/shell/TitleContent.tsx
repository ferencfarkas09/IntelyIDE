import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ipc } from "../ipc";
import { appMode, modeView, setAppMode } from "../platform/mode";
import { needsYouCount } from "../store/agents";
import { snapshots } from "../store/snapshots";
import { repos, workspaceState } from "../store/workspace";
import { t, type MessageKey } from "../i18n";
import { AheadBehind, Badge, BrandButton, Chip, Icon, IconButton, Kbd, Lock, Menu, MiddleEllipsis, Monitor, Moon, Search, SegmentedControl, Settings, Sun, Tooltip, setThemePreference, themePreference, type ThemePreference } from "../ui-kit";
import { execute } from "../platform/commands";
import { formatChord } from "../platform/keymap";
import { setPopupRepo } from "../modules/branches/uiState";
import { AboutDialog, openAbout } from "./AboutDialog";
import { openSettings } from "../platform/settings";
import { BranchPopup } from "./BranchPopup";
import { Switcher } from "./workspace/Switcher";
import "./workspace/switcher.css";

/** No workspace open: Welcome owns the window, so the mode switch and the branch pills have nothing to act on. */
const noWorkspace = (): boolean => workspaceState() === "empty";

export function TitleLeft() {
  return (
    <>
      <BrandButton label={t("title.about")} onClick={openAbout} />
      <Show when={!noWorkspace()}>
      <SegmentedControl
        size="lg"
        variant="accent"
        class="ttl__mode"
        aria-label={t("title.mode")}
        value={appMode()}
        onChange={setAppMode}
        options={[
          {
            value: "agent",
            label: (
              <>
                {t("title.agent")}
                <Show when={needsYouCount() > 0}>
                  <Badge tone="warn" numeric size="sm" title={t("title.waiting")}>
                    {needsYouCount()}
                  </Badge>
                </Show>
              </>
            ),
            ariaLabel: needsYouCount() > 0 ? t("title.agentWaiting", { count: needsYouCount() }) : t("title.agent"),
            disabled: !modeView("agent"),
            tooltip: modeView("agent") ? undefined : t("title.agentSoon"),
          },
          { value: "editor", label: t("title.editor") },
        ]}
      />
      </Show>
      <AboutDialog />
    </>
  );
}

/** Chips that do not fit on the one line of the title bar wrap to a second, clipped line: they are counted here and offered under "N more". */
function hiddenChips(row: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of Array.from(row.children) as HTMLElement[]) {
    const hidden = el.offsetTop > 4;
    el.toggleAttribute("data-clipped", hidden);
    // A clipped chip stays out of the tab order and out of the accessibility tree; "N more" lists it.
    el.toggleAttribute("inert", hidden);
    if (hidden && el.dataset.repo) out.push(el.dataset.repo);
  }
  return out;
}

export function TitleCenter() {
  let row: HTMLDivElement | undefined;
  const [clipped, setClipped] = createSignal<string[]>([], { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) });
  const measure = () => row && setClipped(hiddenChips(row));
  onMount(() => {
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    const mo = new MutationObserver(measure);
    mo.observe(row, { childList: true, subtree: true, characterData: true });
    onCleanup(() => (ro.disconnect(), mo.disconnect()));
    measure();
  });
  const branchOf = (id: string) => {
    const snap = snapshots()[id];
    return snap?.head.branch ?? (snap?.head.detached ? t("title.detached") : snap ? t("title.noCommits") : "…");
  };
  const more = createMemo(() => repos().filter((r) => clipped().includes(r.id)));
  return (
    <div class="ttl" data-tauri-drag-region="deep">
      <Switcher />
      <div class="ttl__repos" ref={row} data-tauri-drag-region="deep">
        <For each={noWorkspace() ? [] : repos()}>
          {(repo) => {
            const snap = () => snapshots()[repo.id];
            const branch = () => branchOf(repo.id);
            const upstream = () => (snap()?.upstream ? `${snap()!.upstream!.remote}/${snap()!.upstream!.branch}` : t("title.noUpstream"));
            return (
              <span class="ttl__chip-slot" data-repo={repo.id}>
                <BranchPopup
                  repo={repo}
                  snapshot={snap()}
                  trigger={(tp) => (
                    <Tooltip label={t("title.branchTip", { repo: repo.name, branch: branch(), upstream: upstream() })} placement="bottom">
                      <button {...tp} type="button" class="ttl__chip" aria-label={t("title.branchAria", { repo: repo.name, branch: branch() })}>
                        <span class="ttl__chip-dot" style={{ background: repo.color }} aria-hidden="true" />
                        <span class="ttl__chip-name">{repo.name}</span>
                        <span class="ttl__chip-branch">
                          <MiddleEllipsis text={branch()} />
                        </span>
                        <AheadBehind ahead={snap()?.ahead ?? 0} behind={snap()?.behind ?? 0} />
                      </button>
                    </Tooltip>
                  )}
                />
              </span>
            );
          }}
        </For>
      </div>
      <Show when={more().length > 0}>
        <Menu
          aria-label={t("title.moreReposAria", { count: more().length })}
          placement="bottom-end"
          items={more().map((r) => ({ label: r.name, description: branchOf(r.id), onSelect: () => setPopupRepo(r.id) }))}
          trigger={(tp) => (
            <Chip {...tp} size="sm" dashed class="ttl__more" aria-label={t("title.moreReposAria", { count: more().length })} data-testid="title-more-repos">
              {t("title.moreRepos", { count: more().length })}
            </Chip>
          )}
        />
      </Show>
    </div>
  );
}

/** The visible way into the command palette: looks like a search field, opens the palette (which owns the typing). */
function PaletteField() {
  return (
    <button type="button" class="ttl__search" data-testid="title-search" aria-label={t("title.searchAria")} aria-haspopup="dialog" onClick={() => void execute("palette.open")}>
      <Icon icon={Search} size={14} />
      <span class="ttl__search-text">{t("title.search")}</span>
      <Kbd keys={formatChord("Cmd+K")} />
    </button>
  );
}

const THEMES = [
  { value: "system", key: "theme.system", icon: Monitor },
  { value: "dark", key: "theme.dark", icon: Moon },
  { value: "light", key: "theme.light", icon: Sun },
] as const satisfies readonly { value: ThemePreference; key: MessageKey; icon: typeof Sun }[];

export function TitleRight() {
  const current = () => THEMES.find((t) => t.value === themePreference()) ?? THEMES[0];
  const [safety] = createResource(() => ipc.settings.safetyStatus().catch(() => null));
  return (
    <>
      <Show when={!noWorkspace()}>
        <PaletteField />
      </Show>
      <Show when={safety()?.jail === "readOnly"}>
        <Badge tone="warn" variant="solid" icon={Lock} title={t("title.readOnlyTip")}>
          {t("title.readOnly")}
        </Badge>
      </Show>
      <Show when={noWorkspace()}>
        <IconButton icon={Settings} label={t("welcome.settings")} size="sm" onClick={() => openSettings()} />
      </Show>
      <Menu
        aria-label={t("title.theme")}
        placement="bottom-end"
        items={THEMES.map((th) => ({ label: t(th.key), icon: th.icon, checked: th.value === themePreference(), onSelect: () => setThemePreference(th.value) }))}
        trigger={(tp) => <IconButton {...tp} icon={current().icon} label={t("title.themeCurrent", { theme: t(current().key) })} size="sm" />}
      />
    </>
  );
}
