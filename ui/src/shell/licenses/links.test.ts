import { describe, expect, it } from "vitest";
import { linkAction } from "./links";

describe("linkAction", () => {
  it("opens allowlisted https hosts and subdomains", () => {
    expect(linkAction("https://www.gnu.org/licenses/gpl-3.0.html")).toMatchObject({ action: "open", hostname: "www.gnu.org" });
    expect(linkAction("https://crates.io/crates/serde/1.0.228")?.action).toBe("open");
    expect(linkAction("https://github.com/serde-rs/serde")?.action).toBe("open");
  });
  it("offers copy for other https hosts, and the extra host opens", () => {
    expect(linkAction("https://example.org/x")).toMatchObject({ action: "copy", hostname: "example.org" });
    expect(linkAction("https://code.example.org/x", ["code.example.org"])?.action).toBe("open");
  });
  it("does not accept lookalike hosts", () => {
    expect(linkAction("https://evilgnu.org/")?.action).toBe("copy");
    expect(linkAction("https://gnu.org.evil.com/")?.action).toBe("copy");
  });
  it("rejects javascript:, file:, http:, userinfo, garbage and overlong urls", () => {
    for (const u of ["javascript:alert(1)", "file:///etc/passwd", "http://gnu.org/", "https://u:p@gnu.org/", "https://u@gnu.org/", "not a url", "", `https://gnu.org/${"a".repeat(200)}`]) {
      expect(linkAction(u)).toBeNull();
    }
  });
});
