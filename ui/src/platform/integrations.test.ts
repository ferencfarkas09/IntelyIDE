import { afterEach, describe, expect, it } from "vitest";
import { Plug } from "../ui-kit";
import { closeIntegration, currentIntegration, integration, integrations, openIntegration, openIntegrations, registerIntegration, resetIntegrations, type Integration } from "./integrations";
import { activeSettingsSection, registerSettingsSection, resetSettings, selectSettingsSection, settingsOpen } from "./settings";

const component = () => null;
const entry = (id: string, order: number, extra: Partial<Integration> = {}): Integration => ({ id, name: id, order, icon: Plug, summary: `${id} summary`, ...extra });
const sections = () => {
  registerSettingsSection({ id: "integrations", title: "Integrations", order: 1, component, searchTerms: [] });
  registerSettingsSection({ id: "mcp", title: "MCP", order: 2, component, searchTerms: [] });
};

afterEach(() => {
  resetIntegrations();
  resetSettings();
});

describe("integrations registry", () => {
  it("lists the entries by order, then by registration", () => {
    registerIntegration(entry("sentry", 30));
    registerIntegration(entry("happy", 10));
    registerIntegration(entry("later", 30));
    expect(integrations().map((i) => i.id)).toEqual(["happy", "sentry", "later"]);
    expect(integration("happy")?.name).toBe("happy");
    expect(integration("nobody")).toBeUndefined();
  });

  it("replaces an entry registered again under the same id", () => {
    registerIntegration(entry("happy", 10, { summary: "old" }));
    registerIntegration(entry("happy", 10, { summary: "new" }));
    expect(integrations()).toHaveLength(1);
    expect(integration("happy")?.summary).toBe("new");
  });
});

describe("opening an integration", () => {
  it("shows the settings of one that has its own screen, inside the Integrations tab", () => {
    sections();
    registerIntegration(entry("happy", 10, { detail: component }));
    selectSettingsSection("mcp");
    openIntegration("happy");
    expect(settingsOpen()).toBe(true);
    expect(activeSettingsSection()?.id).toBe("integrations");
    expect(currentIntegration()?.id).toBe("happy");
  });

  it("goes to the section of one that points at another section", () => {
    sections();
    registerIntegration(entry("mcp", 20, { section: "mcp" }));
    openIntegration("mcp");
    expect(activeSettingsSection()?.id).toBe("mcp");
    expect(currentIntegration()).toBeUndefined();
  });

  it("opens the catalog for a planned entry or one nobody registered, and never leaves a stale screen behind", () => {
    sections();
    registerIntegration(entry("happy", 10, { detail: component }));
    registerIntegration(entry("later", 40, { planned: true }));
    openIntegration("happy");
    openIntegration("later");
    expect(currentIntegration()).toBeUndefined();
    expect(activeSettingsSection()?.id).toBe("integrations");
    openIntegration("happy");
    openIntegration("nobody");
    expect(currentIntegration()).toBeUndefined();
  });

  it("returns to the catalog", () => {
    sections();
    registerIntegration(entry("happy", 10, { detail: component }));
    openIntegration("happy");
    closeIntegration();
    expect(currentIntegration()).toBeUndefined();
    openIntegration("happy");
    openIntegrations();
    expect(currentIntegration()).toBeUndefined();
    expect(settingsOpen()).toBe(true);
  });

  it("shows no screen for an entry that was unregistered while it was open", () => {
    sections();
    const off = registerIntegration(entry("happy", 10, { detail: component }));
    openIntegration("happy");
    off();
    expect(currentIntegration()).toBeUndefined();
  });
});
