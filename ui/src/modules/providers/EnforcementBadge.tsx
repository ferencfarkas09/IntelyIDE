import type { PermissionMode } from "@intely/protocol";
import { For, Show } from "solid-js";
import { t } from "../../i18n";
import type { ProviderEnforcement } from "../../ipc/providers";
import { Badge, Popover, ShieldCheck } from "../../ui-kit";
import { roleKind, suiteLabel, TIER_LABEL, TIER_TONE, tierFor, weakExplanation, WRITE_MIN_TIER, type RoleKind } from "./enforcement";
import "./providers.css";

const kindTitle = (k: RoleKind) => t(k === "readOnly" ? "providers.enf.kind.readOnly" : "providers.enf.kind.write");
const resultWord = (r: "pass" | "fail" | "notRun") => t(r === "pass" ? "providers.enf.result.pass" : r === "fail" ? "providers.enf.result.fail" : "providers.enf.result.notRun");

/**
 * The honest enforcement chip of a provider: a tier computed from attempt suites that actually ran, never configured.
 * Opens an explanation of the tier, the suites behind it, which kind of role the chip covers and the read-only rule.
 * `installed` (the detected CLI version) lets it say when the recorded evidence is for another version.
 */
export function EnforcementBadge(props: { provider: string; name: string; list: readonly ProviderEnforcement[]; mode?: PermissionMode; installed?: string | null; writerAllowed?: boolean }) {
  const kind = (): RoleKind => (props.mode ? roleKind(props.mode) : "write");
  const shown = () => tierFor(props.list, props.provider, kind());
  const recorded = () => props.list.find((e) => e.provider === props.provider && e.roleMode === kind())?.chip.run?.key.cliVersion;
  const stale = () => !!props.installed && !!recorded() && recorded() !== props.installed;
  return (
    <Popover
      aria-label={t("providers.enf.aria", { name: props.name })}
      class="enf-pop"
      placement="top-start"
      trigger={(tr) => (
        <button type="button" {...tr} class="enf-trigger" aria-label={t("providers.enf.trigger", { tier: TIER_LABEL[shown().tier], name: props.name })}>
          <Badge tone={TIER_TONE[shown().tier]} icon={ShieldCheck} variant="outline">
            {t("providers.enf.chip", { tier: TIER_LABEL[shown().tier] })}
          </Badge>
        </button>
      )}
    >
      <div class="enf">
        <header class="enf__head">
          <strong>{t("providers.enf.head", { name: props.name, tier: TIER_LABEL[shown().tier] })}</strong>
        </header>
        <Show when={shown().tier === "weak"}>
          <p class="enf__text">{weakExplanation()}</p>
          <Show when={props.provider === "claude" && shown().results.length === 0}>
            <p class="enf__text">{t("providers.enf.claudeWeak")}</p>
          </Show>
        </Show>
        <Show when={stale()}>
          <p class="enf__text">{t("providers.enf.stale", { recorded: recorded() ?? "", installed: props.installed ?? "" })}</p>
        </Show>
        <p class="enf__text">{t("providers.enf.kindNote", { kind: kindTitle(kind()).toLowerCase() })}</p>
        <For each={["readOnly", "write"] as const}>
          {(k) => {
            const s = () => tierFor(props.list, props.provider, k);
            return (
              <section class="enf__kind" aria-label={kindTitle(k)}>
                <h5 class="enf__kind-title">
                  {kindTitle(k)}
                  <Badge size="sm" tone={TIER_TONE[s().tier]}>{TIER_LABEL[s().tier]}</Badge>
                </h5>
                <Show when={s().results.length > 0} fallback={<p class="enf__text">{t("providers.enf.noSuite")}</p>}>
                  <ul class="enf__suites">
                    <For each={s().results}>
                      {(r) => (
                        <li data-result={r.result}>
                          <span>{suiteLabel(r.suite)}</span>
                          <span class="enf__result">{resultWord(r.result)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={s().downgraded}>
                  <p class="enf__text">{t("providers.enf.downgraded")}</p>
                </Show>
              </section>
            );
          }}
        </For>
        <p class="enf__text">{props.provider === "claude" ? t("providers.enf.claude", { tier: TIER_LABEL[WRITE_MIN_TIER] }) : t("providers.enf.other", { tier: TIER_LABEL[WRITE_MIN_TIER] })}</p>
        <Show when={props.writerAllowed}>
          <p class="enf__text">{t("providers.enf.allowed")}</p>
        </Show>
      </div>
    </Popover>
  );
}
