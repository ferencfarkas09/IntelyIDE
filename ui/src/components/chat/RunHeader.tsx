import { createSignal, For, onCleanup, Show } from "solid-js";
import { execute } from "../../platform/commands";
import type { AgentRow } from "../../store/agents";
import { foreignReason, isForeign } from "../../store/agentScope";
import { repoConfig } from "../../store/workspace";
import { providerName } from "../../modules/providers/catalog";
import { LocationChip } from "../../modules/servers/LocationChip";
import { ProviderMark } from "../../modules/providers/ProviderMark";
import { Badge, FileSearch, IconButton, RepoBadge, Rewind, ShieldCheck, Square, StatusDot, Tooltip } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { costLabel, effortChip, fmtTokens, modelLabel, platformTier, TIER_LABEL, TIER_TITLE, TIER_TONE } from "./format";
import { McpChip } from "./McpChip";
import { ModeChip } from "./ModeChip";
import { HeaderShare } from "../../modules/team/RunShare";
import { RunSlots } from "../RunSlots";
import { effectiveMode } from "./modes";

const STATUS_TEXT = { running: "chat.group.running", needsYou: "chat.group.needsYou", done: "chat.group.done", error: "chat.group.failed" } as const satisfies Record<AgentRow["status"], MessageKey>;
const STATUS_TONE = { running: "accent", needsYou: "warn", done: "ok", error: "danger" } as const;

/** The header shows a throttled or retrying turn as such, though the list still groups it under Running. */
function shownStatus(a: AgentRow): { text: string; tone: "accent" | "warn" | "ok" | "danger" } {
  if (a.status === "running" && a.throttle) return { text: a.throttle.state === "retrying" ? t("chat.throttle.retrying") : t("chat.throttle.throttled"), tone: "warn" };
  return { text: t(STATUS_TEXT[a.status]), tone: STATUS_TONE[a.status] };
}

/** Two letters for the role tile: the first letters of the first two words, or the first two letters of one word. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_\-]+/).filter(Boolean);
  const pick = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
  return pick.toLocaleUpperCase();
}

export function RunHeader(props: { agent: AgentRow; stopping: boolean; onInterrupt: () => void; onRewind: () => void }) {
  const a = () => props.agent;
  const effort = () => effortChip(a());
  const cost = () => costLabel(a().usage, a().caps.usage);
  // the backend already caps the tier on Windows; the UI does too, so an older backend cannot show more than it may
  const tier = () => platformTier(a().enforcement);
  const tierTitle = () => {
    const sandbox = a().caps.sandbox;
    return sandbox.cap !== "yes" && sandbox.note ? t("chat.header.sandbox", { title: TIER_TITLE[tier()], note: sandbox.note }) : TIER_TITLE[tier()];
  };
  const active = () => a().status === "running" || a().status === "needsYou";
  const roleName = () => (a().role === "auto" ? t("runs.role.auto") : a().role);
  // A run of another workspace is read-only: Rewind would overwrite folders this workspace does not hold.
  const foreign = () => isForeign(a().repoIds);
  // Rewind overwrites the working tree, so it needs a second click within a few seconds.
  const [armed, setArmed] = createSignal(false);
  let disarm: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(disarm));
  const rewind = () => {
    if (!armed()) {
      setArmed(true);
      disarm = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(disarm);
    setArmed(false);
    props.onRewind();
  };
  return (
    <header class="run-header" data-testid="run-header" data-bypass={effectiveMode(a()) === "bypass" ? "" : undefined}>
      <div class="run-header__top">
        <span class="run-header__role" title={t("chat.header.provider", { name: providerName(a().provider) })}>
          <span class="run-header__tile" aria-hidden="true">{initials(roleName())}</span>
        </span>
        <h2 class="run-header__title">{a().title}</h2>
        <span class="run-header__state" data-tone={shownStatus(a()).tone}>
          <StatusDot tone={shownStatus(a()).tone} size={6} label={shownStatus(a()).text} />
          <span class="run-header__status">{shownStatus(a()).text}</span>
        </span>
        <span class="run-header__actions">
          {/* Slot for what other modules add to the header (the context ring of the token saver lands here). */}
          <RunSlots place="header" agent={a()} />
          <HeaderShare runId={a().agentId} />
          <IconButton icon={FileSearch} variant="secondary" label={t("chat.header.inspect")} tooltip={t("chat.header.inspectTip")} size="lg" onClick={() => void execute("inspector.open")} />
          <IconButton
            icon={Rewind}
            variant="secondary"
            label={armed() ? t("chat.header.confirmRewind") : t("chat.header.rewind")}
            tooltip={foreign() ? t("scope.rewindOff") : armed() ? t("chat.header.rewindArmedTip") : t("chat.header.rewindTip")}
            size="lg"
            disabled={active() || foreign()}
            onClick={rewind}
          />
          <Show when={active()}>
            <IconButton icon={Square} variant="secondary" label={t("chat.header.interrupt")} tooltip={t("chat.header.interruptTip")} size="lg" loading={props.stopping} onClick={props.onInterrupt} />
          </Show>
        </span>
      </div>
      <Show when={foreign()}>
        <p class="run-header__scope" role="note">{foreignReason(a().repoIds)}</p>
      </Show>
      <div class="run-header__chips">
        <span class="run-header__chip run-header__name">{roleName()}</span>
        <Show when={a().location}>{(id) => <LocationChip id={id()} />}</Show>
        <Show when={(a().delegates?.length ?? 0) > 0}>
          <span class="run-header__chip run-header__lead" title={t("runs.leadTip")}>{t("runs.leadChip", { model: modelLabel(a().model), count: a().delegates!.length })}</span>
        </Show>
        <span class="run-header__chip run-header__provider">
          <ProviderMark id={a().provider} size={14} />
          <Badge title={t("chat.header.providerBadge", { name: a().provider })}>{providerName(a().provider)}</Badge>
        </span>
        <span class="run-header__chip run-header__model">
          <Badge title={t("chat.header.modelBadge", { name: a().model })}>{modelLabel(a().model)}</Badge>
          <span aria-hidden="true">·</span>
          <Badge tone={effort().tone} title={effort().title}>
            {t("chat.header.effort", { text: effort().text })}
          </Badge>
        </span>
        <Show when={a().requested.ultracode}>
          <Badge tone="info" title={t("runpicker.chipTitle")}>
            {t("runpicker.chip")}
          </Badge>
        </Show>
        <ModeChip agent={a()} />
        <McpChip agent={a()} />
        <Tooltip label={tierTitle()}>
          <span class="run-header__tier" tabindex="0" role="note" aria-label={t("chat.header.enforcementAria", { tier: TIER_LABEL[tier()], title: tierTitle() })}>
            <Badge tone={TIER_TONE[tier()]} icon={ShieldCheck} variant="outline">
              {t("chat.header.enforcement", { tier: TIER_LABEL[tier()] })}
            </Badge>
          </span>
        </Tooltip>
        <span class="run-header__repos" role="group" aria-label={t("chat.header.scope")}>
          <For each={a().repoIds}>
            {(id) => (
              <Show when={repoConfig(id)} fallback={<Badge>{id}</Badge>}>
                {(r) => (
                  <>
                    <RepoBadge color={r().color} badge={r().badge} size={16} title={r().name} />
                    <Show when={a().repoIds.length <= 2}>
                      <span class="run-header__repo">{r().name}</span>
                    </Show>
                  </>
                )}
              </Show>
            )}
          </For>
        </span>
        <span class="run-header__grow" />
        <span class="run-header__usage ui-tnum" title={cost().title}>
          <Show when={a().usage}>{(u) => (
              <span class="run-header__tokens">
                {t("chat.header.tokens", { input: fmtTokens(u().cumulative.inputTokens), output: fmtTokens(u().cumulative.outputTokens) })}
              </span>
            )}</Show>
          <span class="run-header__cost">{cost().text}</span>
        </span>
      </div>
    </header>
  );
}
