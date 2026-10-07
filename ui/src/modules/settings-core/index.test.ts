import { afterEach, describe, expect, it } from "vitest";
import { resetSettings, settingsSections } from "../../platform/settings";
import { register } from "./index";
import { register as registerProviders } from "../providers";
import { setLocale } from "../../i18n";

afterEach(() => (resetSettings(), setLocale("en")));

describe("settings sections", () => {
  it("settings-core and providers register the seven sections in sidebar order, with titles that follow the language", async () => {
    register();
    registerProviders();
    expect(settingsSections().map((s) => [s.id, s.title])).toEqual([
      ["general", "General"],
      ["appearance", "Appearance"],
      ["editor", "Editor"],
      ["providers", "Providers"],
      ["safety", "Safety"],
      ["keyboard", "Keyboard"],
      ["about", "About"],
    ]);
    await setLocale("hu");
    expect(settingsSections().map((s) => s.title)).toContain("Szolgáltatók");
  });
});
