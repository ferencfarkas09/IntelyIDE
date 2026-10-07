import { createEffect, createMemo, createSignal, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { RoleProviderCaps } from "../../ipc/roles";
import { Input, Select, Switch } from "../../ui-kit";
import { clampEffort } from "./rolesLogic";

/** Settings namespace `agents`: read at every start by the host ((design notes: roles-orchestration-spec) 4.2). Defaults apply for anything absent. */
export interface AgentsSettings {
  defaultModel?: string;
  defaultEffort?: string;
  delegationCap?: number;
  maxBudgetUsd?: number;
  auto?: { enabled?: boolean };
  delegation?: { enabled?: boolean };
  /** Put the user's own ~/.claude/CLAUDE.md into the prompt of an agent run (default on). */
  includeUserMemory?: boolean;
}

export const DEFAULT_CAP = 12;
export const CAP_RANGE = { min: 1, max: 40 } as const;

/** "Use optimal settings": the Auto run as it should run (Sonnet leads at medium effort, up to 12 roles, both switches on). The spend cap is left as the user set it. */
export const OPTIMAL_AGENTS: Record<string, unknown> = { defaultModel: "sonnet", defaultEffort: "medium", delegationCap: DEFAULT_CAP, auto: { enabled: true }, delegation: { enabled: true } };

/** The model option a stored value (an alias such as `sonnet` or a full id) stands for. */
export const modelFor = (value: string | undefined, caps: RoleProviderCaps | undefined): string | undefined => {
  const models = caps?.models ?? [];
  const wanted = value ?? "sonnet";
  return (models.find((m) => m.id === wanted) ?? models.find((m) => m.id.includes(wanted)) ?? models.find((m) => m.id.includes("sonnet")) ?? models[0])?.id;
};

/** Settings > Roles: the lead of an Auto run (model, effort, cap, spend) and its two kill switches. */
export function AutoSettings(props: { caps: RoleProviderCaps[]; /** Bumped when the settings were changed from outside (the optimal-settings button): the section reads them again. */ version?: number }) {
  const [value, setValue] = createSignal<AgentsSettings>({});
  const [error, setError] = createSignal<string | undefined>(undefined);
  const claude = () => props.caps.find((c) => c.provider === "claude");
  const model = () => modelFor(value().defaultModel, claude());
  const levels = () => claude()?.models.find((m) => m.id === model())?.effortLevels ?? [];
  const effort = () => (levels().length === 0 ? "" : (levels().includes(value().defaultEffort as never) ? value().defaultEffort : clampEffort("medium", levels())) ?? "");
  const cap = () => value().delegationCap ?? DEFAULT_CAP;
  const autoOn = () => value().auto?.enabled !== false;
  const delegationOn = () => value().delegation?.enabled !== false;
  const memoryOn = () => value().includeUserMemory !== false;
  const [capText, setCapText] = createSignal<string | undefined>(undefined);
  const capInvalid = createMemo(() => {
    const raw = capText();
    if (raw === undefined) return false;
    const n = Number(raw);
    return !Number.isInteger(n) || n < CAP_RANGE.min || n > CAP_RANGE.max;
  });

  const load = () => void ipc.settings.get("agents").then((v) => setValue(v as AgentsSettings), () => {});
  onMount(load);
  createEffect(on(() => props.version, load, { defer: true }));

  const save = async (patch: Record<string, unknown>) => {
    setError(undefined);
    try {
      setValue((await ipc.settings.set("agents", patch)) as AgentsSettings);
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    }
  };

  return (
    <section class="roles-auto" aria-labelledby="roles-auto-title">
      <header class="roles-auto__head">
        <h3 id="roles-auto-title" class="roles-auto__title">{t("roles.auto.title")}</h3>
        <p class="roles-auto__desc">{t("roles.auto.desc")}</p>
      </header>
      <div class="roles-auto__grid">
        <label class="roles-auto__field">
          <span class="roles__label">{t("roles.auto.model")}</span>
          <Select
            size="sm"
            aria-label={t("roles.auto.model")}
            value={model()}
            options={(claude()?.models ?? []).map((m) => ({ value: m.id, label: m.label }))}
            onChange={(id) => void save({ defaultModel: id, ...(claude()?.models.find((m) => m.id === id)?.effortLevels.length ? {} : { defaultEffort: null }) })}
          />
        </label>
        <label class="roles-auto__field">
          <span class="roles__label">{t("roles.auto.effort")}</span>
          <Select
            size="sm"
            aria-label={t("roles.auto.effort")}
            disabled={levels().length === 0}
            title={levels().length === 0 ? t("roles.err.noEffortControl") : undefined}
            value={effort() as string}
            options={levels().length === 0 ? [{ value: "", label: t("roles.na") }] : levels().filter((l) => l !== "max").map((l) => ({ value: l, label: l }))}
            onChange={(e) => void save({ defaultEffort: e })}
          />
        </label>
        <label class="roles-auto__field">
          <span class="roles__label">{t("roles.auto.cap")}</span>
          <Input
            size="sm"
            type="number"
            min={CAP_RANGE.min}
            max={CAP_RANGE.max}
            aria-label={t("roles.auto.cap")}
            invalid={capInvalid()}
            value={capText() ?? String(cap())}
            onInput={(e) => setCapText(e.currentTarget.value)}
            onChange={(e) => {
              if (capInvalid()) return;
              void save({ delegationCap: Number(e.currentTarget.value) }).then(() => setCapText(undefined));
            }}
          />
        </label>
        <label class="roles-auto__field">
          <span class="roles__label">{t("roles.auto.budget")}</span>
          <Input
            size="sm"
            type="number"
            min={0}
            step={1}
            placeholder={t("roles.auto.budgetNone")}
            aria-label={t("roles.auto.budget")}
            value={value().maxBudgetUsd === undefined ? "" : String(value().maxBudgetUsd)}
            onChange={(e) => {
              const raw = e.currentTarget.value.trim();
              void save({ maxBudgetUsd: raw === "" || Number(raw) <= 0 ? null : Number(raw) });
            }}
          />
        </label>
      </div>
      <p class="roles-auto__hint">{t("roles.auto.budgetHint")}</p>
      <div class="roles-auto__switches" role="group" aria-label={t("settings.agents.killSwitch.title")}>
        <Switch size="sm" checked={autoOn()} label={t("settings.agents.killSwitch.auto")} onChange={(on) => void save({ auto: { enabled: on } })} />
        <Switch size="sm" checked={delegationOn()} disabled={!autoOn()} label={t("settings.agents.killSwitch.delegation")} onChange={(on) => void save({ delegation: { enabled: on } })} />
      </div>
      <div class="roles-auto__switches">
        <Switch size="sm" checked={memoryOn()} label={t("memory.includeUserMemory")} onChange={(on) => void save({ includeUserMemory: on })} />
      </div>
      <p class="roles-auto__hint">{t("memory.includeUserMemory.hint")}</p>
      <Show when={!autoOn() || !delegationOn()}>
        <p class="roles-auto__hint">{!autoOn() ? t("settings.agents.killSwitch.autoOff") : t("settings.agents.killSwitch.delegationOff")}</p>
      </Show>
      <Show when={error()}>{(msg) => <p class="roles__shadow-error" role="alert">{msg()}</p>}</Show>
    </section>
  );
}
