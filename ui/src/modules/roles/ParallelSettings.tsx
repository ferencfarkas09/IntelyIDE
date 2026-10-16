import { createEffect, createMemo, createSignal, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { Input, Switch } from "../../ui-kit";
import type { AgentsSettings } from "./AutoSettings";

export const DEFAULT_MAX_RUNS = 12;
export const MAX_RUNS_RANGE = { min: 1, max: 64 } as const;
export const MIN_MEMORY_MB = 512;
/** 1 TiB: far above any Mac, and what the host holds a larger value to anyway. */
export const MAX_MEMORY_MB = 1_048_576;

/** A whole number within the range. */
export const validMaxRuns = (raw: string): boolean => {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isInteger(n) && n >= MAX_RUNS_RANGE.min && n <= MAX_RUNS_RANGE.max;
};

/** Empty (automatic) or a whole number between 512 and 1048576. */
export const validMemoryMb = (raw: string): boolean => {
  if (raw.trim() === "") return true;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= MIN_MEMORY_MB && n <= MAX_MEMORY_MB;
};

/** Settings > Roles: how many runs this Mac works on at once, whether they may share a repository, and their memory. */
export function ParallelSettings(props: { /** Bumped when the settings were changed from outside (the optimal-settings button): the card reads them again. */ version?: number }) {
  const [value, setValue] = createSignal<AgentsSettings>({});
  const [error, setError] = createSignal<string | undefined>(undefined);
  const maxRuns = () => value().maxRuns ?? DEFAULT_MAX_RUNS;
  const sharedOn = () => value().sharedRepoWrites !== false;
  const [runsText, setRunsText] = createSignal<string | undefined>(undefined);
  const [memText, setMemText] = createSignal<string | undefined>(undefined);
  const runsInvalid = createMemo(() => runsText() !== undefined && !validMaxRuns(runsText()!));
  const memInvalid = createMemo(() => memText() !== undefined && !validMemoryMb(memText()!));

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
    <section class="roles-auto" aria-labelledby="roles-parallel-title">
      <header class="roles-auto__head">
        <h3 id="roles-parallel-title" class="roles-auto__title">{t("roles.parallel.title")}</h3>
        <p class="roles-auto__desc">{t("roles.parallel.desc")}</p>
      </header>
      <div class="roles-auto__grid">
        <label class="roles-auto__field">
          <span class="roles__label">{t("roles.parallel.max")}</span>
          <Input
            size="sm"
            type="number"
            min={MAX_RUNS_RANGE.min}
            max={MAX_RUNS_RANGE.max}
            step={1}
            aria-label={t("roles.parallel.max")}
            invalid={runsInvalid()}
            value={runsText() ?? String(maxRuns())}
            onInput={(e) => setRunsText(e.currentTarget.value)}
            onChange={(e) => {
              if (runsInvalid()) return;
              void save({ maxRuns: Number(e.currentTarget.value) }).then(() => setRunsText(undefined));
            }}
          />
        </label>
        <label class="roles-auto__field">
          <span class="roles__label">{t("roles.parallel.memory")}</span>
          <Input
            size="sm"
            type="number"
            min={MIN_MEMORY_MB}
            max={MAX_MEMORY_MB}
            step={256}
            placeholder={t("roles.parallel.memoryAuto")}
            aria-label={t("roles.parallel.memory")}
            invalid={memInvalid()}
            value={memText() ?? (value().memoryBudgetMb === undefined ? "" : String(value().memoryBudgetMb))}
            onInput={(e) => setMemText(e.currentTarget.value)}
            onChange={(e) => {
              if (memInvalid()) return;
              const raw = e.currentTarget.value.trim();
              void save({ memoryBudgetMb: raw === "" ? null : Number(raw) }).then(() => setMemText(undefined));
            }}
          />
        </label>
      </div>
      <p class="roles-auto__hint">{t("roles.parallel.maxHint")}</p>
      <Show when={runsInvalid() || memInvalid()}>
        <p class="roles-auto__hint" role="alert">{t("roles.parallel.invalid")}</p>
      </Show>
      <p class="roles-auto__hint">{t("roles.parallel.memoryHint")}</p>
      <div class="roles-auto__switches">
        <Switch size="sm" checked={sharedOn()} label={t("roles.parallel.shared")} onChange={(on) => void save({ sharedRepoWrites: on })} />
      </div>
      <p class="roles-auto__hint">{t("roles.parallel.sharedHint")}</p>
      <Show when={error()}>{(msg) => <p class="roles__shadow-error" role="alert">{msg()}</p>}</Show>
    </section>
  );
}
