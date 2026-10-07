import { For, Show } from "solid-js";
import { openSheet, sheetAttention, sheetOpen } from "../../store/actions";
import { selectionSummary } from "../../store/selection";
import { envStatus, repoConfig, repos, runningOps, type RunningOp } from "../../store/workspace";
import { Spinner, StatusDot, Tooltip, type Tone } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";

const ENV_TEXT = { resolving: "statusbar.env.resolving", ready: "statusbar.env.ready", failed: "statusbar.env.failed" } as const satisfies Record<string, MessageKey>;
const ENV_TONE = { resolving: "accent", ready: "ok", failed: "danger" } as const satisfies Record<string, Tone>;
const VERB = { commit: "statusbar.op.commit", push: "statusbar.op.push", pull: "statusbar.op.pull", fetch: "statusbar.op.fetch" } as const satisfies Record<string, MessageKey>;

function describe(op: RunningOp): string {
  const entries = Object.entries(op.repos);
  const names = entries.map(([id]) => repoConfig(id)?.name ?? id);
  const pct = entries.map(([, r]) => r.percent).filter((p): p is number => typeof p === "number");
  const progress = pct.length ? `  ${Math.round(Math.min(...pct))}%` : "";
  return `${t(VERB[op.kind], { what: names.length > 2 ? t("statusbar.repoCount", { n: names.length }) : names.join(", ") })}${progress}`;
}

export function EnvItem() {
  const env = envStatus;
  return (
    <Tooltip label={env()?.message ?? (env() ? `${env()!.gitPath} (${env()!.source})` : t("statusbar.env.tip"))}>
      <span class="sb__item" tabIndex={0}>
        <StatusDot tone={env() ? ENV_TONE[env()!.state] : "accent"} pulse={!env() || env()!.state === "resolving"} size={6} />
        <span>{t(env() ? ENV_TEXT[env()!.state] : ENV_TEXT.resolving)}</span>
      </span>
    </Tooltip>
  );
}

export function OpsItem() {
  return (
    <div class="sb__ops" role="status" aria-live="polite">
      <For each={runningOps()}>
        {(op) => (
          <span class="sb__item sb__op">
            <Spinner size={12} />
            <span class="ui-truncate">{describe(op)}</span>
          </span>
        )}
      </For>
    </div>
  );
}

export function AttentionItem() {
  return (
    <Show when={!sheetOpen() && sheetAttention() > 0}>
      <button type="button" class="sb__item sb__attention" onClick={openSheet}>
        <StatusDot tone="warn" size={6} />
        <span>{t("statusbar.attention", { n: sheetAttention() })}</span>
      </button>
    </Show>
  );
}

export function SelectionItem() {
  const summary = () => selectionSummary(repos().map((r) => r.id));
  return (
    <Show when={summary().files > 0}>
      <span class="sb__item ui-tnum">
        {t("statusbar.selected", { files: summary().files, repos: summary().repos })}
      </span>
    </Show>
  );
}
