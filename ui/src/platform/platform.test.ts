import { afterEach, describe, expect, it } from "vitest";
import { applyPlatformAttribute, currentPlatform, detectPlatform } from "./platform";

describe("platform", () => {
  afterEach(() => delete document.documentElement.dataset.platform);

  it("reads the platform from the webview's navigator", () => {
    expect(detectPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140.0" })).toBe("windows");
    expect(detectPlatform({ userAgentData: { platform: "Windows" } })).toBe("windows");
    expect(detectPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("linux");
    expect(detectPlatform({})).toBe("linux");
  });

  it("writes data-platform on <html> and reads it back", () => {
    expect(applyPlatformAttribute(document, "windows")).toBe("windows");
    expect(document.documentElement.dataset.platform).toBe("windows");
    expect(currentPlatform()).toBe("windows");
    applyPlatformAttribute(document, "mac");
    expect(currentPlatform()).toBe("mac");
  });
});
