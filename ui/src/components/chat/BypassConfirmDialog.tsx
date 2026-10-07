import { createUniqueId, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import type { McpExposure } from "../../store/agent-types";
import { Button, Dialog } from "../../ui-kit";
import { exposureOf } from "./modes";
import "./modes.css";

/**
 * What Bypass keeps blocked, one id per bullet. The ids are exactly the `bypassKeeps` of `constants.json`, the list the policy
 * tests pin against real `decide` calls: a bullet that is not a hard stop must not be listed here, and a hard stop must be.
 */
export const BYPASS_KEEPS = ["git", "gitTricks", "protectedPaths", "persistence", "secrets", "wrangler", "ideState", "procEnv", "isolation", "catastrophic"] as const;
export const BYPASS_OFF = ["prompts", "boundary", "static", "network"] as const;

const KEEP_KEY = (id: (typeof BYPASS_KEEPS)[number]) => `modes.bypass.keeps.${id}` as MessageKey;
const OFF_KEY = (id: (typeof BYPASS_OFF)[number]) => `modes.bypass.off.${id}` as MessageKey;

export interface BypassConfirmDialogProps {
  open: boolean;
  /** Where it was asked from: a new run (the New run dialog) or a live switch (the header chip). Both read the same words. */
  context: "start" | "switch";
  onConfirm: () => void;
  onCancel: () => void;
  /** The MCP servers of the run, when known: a bullet says what they run without asking. */
  mcp?: readonly McpExposure[];
}

/** The one dialog between a person and Bypass. Cancel has the focus; nothing here ever confirms by itself or remembers a yes. */
export function BypassConfirmDialog(props: BypassConfirmDialogProps) {
  const exposure = () => exposureOf(props.mcp);
  const uid = createUniqueId();
  return (
    <Dialog open={props.open} onClose={props.onCancel} title={t("modes.bypass.title")} description={t("modes.bypass.lead")} size="md" role="alertdialog" closeOnBackdrop={false} hideClose class="bypass-dialog" footer={
      <>
        <Button variant="secondary" data-autofocus onClick={props.onCancel}>
          {t("modes.bypass.cancel")}
        </Button>
        <Button variant="danger" onClick={props.onConfirm}>
          {t("modes.bypass.confirm")}
        </Button>
      </>
    }>
      <div class="bypass-confirm" data-context={props.context}>
        <section class="bypass-confirm__section" aria-labelledby={`${uid}-off`}>
          <h3 class="bypass-confirm__title" id={`${uid}-off`}>
            {t("modes.bypass.offTitle")}
          </h3>
          <ul class="bypass-confirm__list" data-kind="off">
            <For each={BYPASS_OFF}>{(id) => <li class="bypass-confirm__item" data-id={id}>{t(OFF_KEY(id))}</li>}</For>
            <Show when={exposure().count > 0}>
              <li class="bypass-confirm__item" data-id="mcpServers">
                {t("modes.bypass.off.mcpServers", { count: exposure().count, names: exposure().names })}
              </li>
            </Show>
          </ul>
        </section>
        <section class="bypass-confirm__section" aria-labelledby={`${uid}-keeps`}>
          <h3 class="bypass-confirm__title" id={`${uid}-keeps`}>
            {t("modes.bypass.keepsTitle")}
          </h3>
          <ul class="bypass-confirm__list" data-kind="keeps">
            <For each={BYPASS_KEEPS}>{(id) => <li class="bypass-confirm__item" data-id={id}>{t(KEEP_KEY(id))}</li>}</For>
          </ul>
        </section>
        <p class="bypass-confirm__foot">{t("modes.bypass.footnote")}</p>
      </div>
    </Dialog>
  );
}
