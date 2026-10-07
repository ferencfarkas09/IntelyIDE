import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Bell, Inbox, Settings as SettingsIcon } from "lucide-solid";
import { boot, needsYouCards, state } from "./core/app";
import Home from "./screens/Home";
import Onboarding, { takeFragmentOffer } from "./screens/Onboarding";
import RunDetail from "./screens/RunDetail";
import Revoked from "./screens/Revoked";
import Settings, { IntegrityBanner } from "./screens/Settings";
import { go } from "./ui/nav";
import { TabBar } from "./ui/TabBar";

type Route = { name: "home" } | { name: "settings" } | { name: "run"; id: string };

export function parseRoute(hash: string): Route {
  const m = /^#\/run\/(.+)$/.exec(hash);
  if (m) return { name: "run", id: decodeURIComponent(m[1]!) };
  if (hash === "#/settings") return { name: "settings" };
  return { name: "home" };
}

export default function App() {
  const [route, setRoute] = createSignal<Route>(parseRoute(location.hash));
  const offer = takeFragmentOffer(); // read once, then the address bar is clean
  const onHash = () => setRoute(parseRoute(location.hash));
  onMount(() => {
    addEventListener("hashchange", onHash);
    boot();
    if (!location.hash) history.replaceState(null, "", "#/");
  });
  onCleanup(() => removeEventListener("hashchange", onHash));
  const current = () => (route().name === "settings" ? "settings" : "home");

  return (
    <Switch>
      <Match when={state.phase === "boot"}>
        <main class="screen center-screen" aria-busy="true" />
      </Match>
      <Match when={state.phase === "onboarding"}>
        <Onboarding initialOffer={offer} />
      </Match>
      <Match when={state.phase === "revoked"}>
        <Revoked />
      </Match>
      <Match when={state.phase === "main"}>
        <div class="app">
          <IntegrityBanner />
          <Show when={route().name === "run"} fallback={route().name === "settings" ? <Settings /> : <Home />}>
            <RunDetail agentId={(route() as { id: string }).id} />
          </Show>
          <Show when={route().name !== "run"}>
            <TabBar
              current={current()}
              onSelect={(id) => go(id === "settings" ? "#/settings" : "#/")}
              tabs={[
                { id: "home", label: "Sessions", icon: Inbox, badge: needsYouCards().length || undefined },
                { id: "settings", label: "Devices", icon: SettingsIcon },
              ]}
            />
          </Show>
        </div>
      </Match>
    </Switch>
  );
}
