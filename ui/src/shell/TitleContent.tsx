import { createResource, For, Show } from "solid-js";
import { ipc } from "../ipc";
import { appMode, modeView, setAppMode } from "../platform/mode";
import { needsYouCount } from "../store/agents";
import { snapshots } from "../store/snapshots";
import { repos, workspaceState } from "../store/workspace";
import { t, type MessageKey } from "../i18n";
import { AheadBehind, Badge, BrandButton, Icon, IconButton, Lock, Menu, MiddleEllipsis, Monitor, Moon, Pill, RepoBadge, SegmentedControl, Settings, Sun, Tooltip, setThemePreference, themePreference, type ThemePreference } from "../ui-kit";
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
        size="sm"
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

export function TitleCenter() {
  return (
    <div class="ttl" data-tauri-drag-region="deep">
      <Switcher />
      <For each={noWorkspace() ? [] : repos()}>
        {(repo) => {
          const snap = () => snapshots()[repo.id];
          const branch = () => snap()?.head.branch ?? (snap()?.head.detached ? t("title.detached") : snap() ? t("title.noCommits") : "…");
          const upstream = () => (snap()?.upstream ? `${snap()!.upstream!.remote}/${snap()!.upstream!.branch}` : t("title.noUpstream"));
          return (
            <BranchPopup
              repo={repo}
              snapshot={snap()}
              trigger={(tp) => (
                <Tooltip label={t("title.branchTip", { repo: repo.name, branch: branch(), upstream: upstream() })} placement="bottom">
                  <Pill
                    size="sm"
                    onClick={tp.onClick}
                    buttonProps={tp}
                    aria-label={t("title.branchAria", { repo: repo.name, branch: branch() })}
                    leading={<RepoBadge color={repo.color} badge={repo.badge} size={16} />}
                    trailing={<AheadBehind ahead={snap()?.ahead ?? 0} behind={snap()?.behind ?? 0} />}
                  >
                    <MiddleEllipsis text={branch()} />
                  </Pill>
                </Tooltip>
              )}
            />
          );
        }}
      </For>
    </div>
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
