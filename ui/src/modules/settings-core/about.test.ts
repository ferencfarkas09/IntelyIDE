import { describe, expect, it } from "vitest";
import { loadAbout, webviewLabel } from "./about";

describe("about", () => {
  it("reports a browser host without Tauri and shortens the user agent", async () => {
    expect(await loadAbout()).toMatchObject({ app: "dev", tauri: null, host: "browser" });
    expect(webviewLabel("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15")).toBe("WebKit 605.1.15");
    expect(webviewLabel("")).toBe("—");
  });
});
