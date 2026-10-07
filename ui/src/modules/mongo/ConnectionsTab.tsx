import { createSignal, onMount } from "solid-js";
import { t } from "../../i18n";
import type { AiMode } from "../../ipc/mongo";
import type { TabInstance } from "../../platform/tabs";
import type { ConnectionsAction } from "./gate";
import { ConnectionManager } from "./ConnectionManager";
import { readPrefs } from "./onboarding/prefs";
import "./mongo.css";
import "./manage.css";

/** The connection manager as a centre tab: the page you land on from the rail's "+" and from the palette's Studio commands. */
export default function ConnectionsTab(props: { tab: TabInstance }) {
  const [defaultAi, setDefaultAi] = createSignal<AiMode>("off");
  onMount(() => void readPrefs().then((p) => setDefaultAi(p.defaultAi)).catch(() => undefined));
  const action = () => {
    const a = props.tab.params?.action as ConnectionsAction | undefined;
    const nonce = props.tab.params?.nonce as number | undefined;
    return a && nonce ? { action: a, nonce } : undefined;
  };
  return (
    <section class="mg-page" aria-label={t("mongoManage.page.aria")}>
      <header class="mg-page__head">
        <h2 class="mg-page__title">{t("mongoManage.tab.connections")}</h2>
        <p class="mg-page__sub">{t("mongoManage.page.sub")}</p>
      </header>
      <ConnectionManager defaultAi={defaultAi()} action={action()} />
    </section>
  );
}
