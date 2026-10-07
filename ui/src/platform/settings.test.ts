import { afterEach, describe, expect, it } from "vitest";
import { activeSettingsSection, closeSettings, filterSections, openSettings, registerSettingsSection, resetSettings, selectSettingsSection, settingsOpen, settingsSections } from "./settings";

const component = () => null;
const section = (id: string, order: number, searchTerms: string[] = []) => ({ id, title: id[0].toUpperCase() + id.slice(1), order, component, searchTerms });

afterEach(resetSettings);

describe("settings registry", () => {
  it("lists sections by order and defaults to the first", () => {
    registerSettingsSection(section("terminal", 20));
    registerSettingsSection(section("editor", 10));
    expect(settingsSections().map((s) => s.id)).toEqual(["editor", "terminal"]);
    expect(activeSettingsSection()?.id).toBe("editor");
  });

  it("opens on a given section and falls back when it disappears", () => {
    registerSettingsSection(section("editor", 10));
    openSettings("missing");
    expect(settingsOpen()).toBe(true);
    expect(activeSettingsSection()?.id).toBe("editor");
    registerSettingsSection(section("terminal", 20));
    selectSettingsSection("terminal");
    expect(activeSettingsSection()?.id).toBe("terminal");
    closeSettings();
    expect(settingsOpen()).toBe(false);
  });

  it("filters by title and search terms, every word must match", () => {
    registerSettingsSection(section("editor", 10, ["font size", "tab width"]));
    registerSettingsSection(section("providers", 20, ["api key"]));
    expect(filterSections("font").map((s) => s.id)).toEqual(["editor"]);
    expect(filterSections("api provid").map((s) => s.id)).toEqual(["providers"]);
    expect(filterSections("font api")).toEqual([]);
    expect(filterSections("")).toHaveLength(2);
  });
});
