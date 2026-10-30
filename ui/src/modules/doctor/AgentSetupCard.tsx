import { createSignal, onMount, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { ProviderInfo } from "../../ipc/providers";
import type { NewRunSlotContext } from "../../platform/newRunSlots";
import { Button, Icon, Wrench } from "../../ui-kit";
import { agentRows } from "./logic";
import { openDoctor } from "./open";
import "./doctor.css";

/** Why Claude cannot start a run right now, from the provider state the app keeps (no process is started); undefined when it can. */
export function agentBlocker(claude: Pick<ProviderInfo, "id" | "state" | "message"> | undefined): "sdk" | "login" | "cli" | undefined {
  if (!claude || claude.state === "off" || claude.state === "probing") return undefined;
  const [sdk, login] = agentRows(claude);
  if (sdk.status !== "ok") return "sdk";
  if (login.status === "missing") return "login";
  if (claude.state === "notInstalled" || claude.state === "error") return "cli";
}

/** The first-run card of the New Run dialog: shown only while the agent cannot start, with the way to the Setup doctor (the dialog closes so the tab is seen). */
export default function AgentSetupCard(props: { ctx?: NewRunSlotContext }) {
  const [why, setWhy] = createSignal<ReturnType<typeof agentBlocker>>();
  onMount(() => void ipc.providers.list().then((list) => setWhy(agentBlocker(list.find((p) => p.id === "claude"))), () => undefined));
  return (
    <Show when={why()}>
      {(w) => (
        <div class="setupcard" role="status">
          <Icon icon={Wrench} size={14} />
          <span class="setupcard__text">{t(`setup.card.${w()}` as MessageKey)}</span>
          <Button size="sm" variant="secondary" onClick={() => (props.ctx?.close?.(), openDoctor())}>{t("setup.card.open")}</Button>
        </div>
      )}
    </Show>
  );
}
