import { createSignal, type Component } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import type { Tone } from "../ui-kit";
import { createRegistry } from "./registry";
import { openSettings } from "./settings";

export interface IntegrationStatus {
  tone: Tone;
  label: string;
}

/** One entry of the catalog in Settings > Integrations: a service the IDE connects to, or a way of connecting (MCP). */
export interface Integration {
  id: string;
  /** The name of the service. A brand, so it is not translated. */
  name: string;
  /** Position in the catalog; built-ins use 10, 20, 30... */
  order: number;
  icon: LucideIcon;
  /** What it does, in a sentence, under the name. Read at render time, so it follows the language. */
  readonly summary: string;
  /** The chip on the card. Read in the card, so it follows the connection and the language. */
  status?: () => IntegrationStatus;
  /** Called when the catalog is shown, to load what `status` needs. Must be cheap and safe to call again. */
  load?: () => void;
  /** Its settings, shown inside the Integrations tab with a way back to the catalog. */
  detail?: Component;
  /** Or the id of the settings section that already holds them (MCP servers, Sentry): the card opens it. */
  section?: string;
  /** Announced, not there yet: the card is shown and nothing opens. */
  planned?: boolean;
}

const registry = createRegistry<Integration>((i) => i.order, "integrations");

export const registerIntegration = registry.register;
export const integrations = registry.items;
export const integration = registry.get;

const [current, setCurrent] = createSignal<string | null>(null);

/** The integration whose settings the tab shows instead of the catalog; null for the catalog. */
export const currentIntegration = (): Integration | undefined => {
  const i = registry.get(current() ?? "");
  return i?.detail ? i : undefined;
};

export function closeIntegration(): void {
  setCurrent(null);
}

/** The catalog of Settings > Integrations. */
export function openIntegrations(): void {
  setCurrent(null);
  openSettings("integrations");
}

/** An integration's own settings: inside the Integrations tab, or in the section it points at. An id nobody registered opens the catalog. */
export function openIntegration(id: string): void {
  const i = registry.get(id);
  if (i?.section) {
    openSettings(i.section);
    return;
  }
  if (i?.detail) {
    setCurrent(id);
    openSettings("integrations");
    return;
  }
  openIntegrations();
}

export function resetIntegrations(): void {
  registry.clear();
  setCurrent(null);
}
