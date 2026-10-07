import type { Cap, CapKey } from "@intely/protocol";
import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ProviderCapsReport } from "../../ipc/providers";
import { Badge, Button, Popover, Skeleton } from "../../ui-kit";
import { CAP_ROWS, capSummary } from "./caps";
import "./providers.css";

const mark = (c: Cap): string => t(c === "yes" ? "providers.caps.yes" : c === "partial" ? "providers.caps.partial" : "providers.caps.no");
const TONE: Record<Cap, "ok" | "warn" | "neutral"> = { yes: "ok", partial: "warn", no: "neutral" };

/** The capability matrix of one provider in a popover. Loaded when it opens, so a closed one costs nothing. */
export function CapsMatrix(props: { id: string; name: string; /** A Test run just negotiated these capabilities: read them again the next time the matrix opens. */ refreshKey?: number }) {
  const [report, setReport] = createSignal<ProviderCapsReport | null>(null);
  const [failed, setFailed] = createSignal(false);
  let loadedFor: number | undefined;
  const load = () => {
    if (report() && loadedFor === props.refreshKey) return;
    loadedFor = props.refreshKey;
    ipc.providers.caps(props.id).then(setReport, () => setFailed(true));
  };
  return (
    <Popover
      aria-label={t("providers.caps.aria", { name: props.name })}
      class="caps-pop"
      placement="bottom-end"
      onOpenChange={(open) => open && load()}
      trigger={(tr) => (
        <Button {...tr} size="sm" variant="ghost" aria-label={t("providers.caps.buttonAria", { name: props.name })}>
          {t("providers.caps.button")}
        </Button>
      )}
    >
      <div class="caps">
        <header class="caps__head">
          <strong>{props.name}</strong>
          <Show when={report()}>{(r) => <span class="caps__source">{r().source === "runtime" ? t("providers.caps.negotiated") : t("providers.caps.defaults")}</span>}</Show>
        </header>
        <Show when={!failed()} fallback={<p class="caps__note">{t("providers.caps.failed")}</p>}>
          <Show when={report()} fallback={<Skeleton height={120} />}>
            {(r) => (
              <>
                <table class="caps__table">
                  <caption class="ui-sr-only">{t("providers.caps.aria", { name: props.name })}</caption>
                  <tbody>
                    <For each={CAP_ROWS}>
                      {(row) => {
                        const entry = () => r().caps[row.key as CapKey];
                        return (
                          <tr>
                            <th scope="row">{row.label}</th>
                            <td>
                              <Badge size="sm" tone={TONE[entry().cap]} title={row.hint}>
                                {mark(entry().cap)}
                              </Badge>
                            </td>
                            <td class="caps__why">{entry().note ?? ""}</td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
                <p class="caps__note">{capSummary(r().caps)}</p>
              </>
            )}
          </Show>
        </Show>
      </div>
    </Popover>
  );
}
