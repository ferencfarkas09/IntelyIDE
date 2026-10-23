import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, parsePrefs } from "./prefs";

describe("parsePrefs", () => {
  it("is the defaults for nothing, and for rubbish", () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ assignee: 7, role: "", permission: "bypass", start: "later", template: 5, repoMap: "x" })).toEqual(DEFAULT_PREFS);
  });

  it("reads a saved choice", () => {
    expect(parsePrefs({ assignee: { mode: "pick", kind: "team", id: "7", name: "#backend" }, role: "reviewer", permission: "ask", start: "review", template: "Fix {{ID}}", repoMap: { "shop-admin": ["shop-admin", " shop-backend ", ""], empty: [], "": ["x"], single: "shop-pos" } })).toEqual({
      assignee: { mode: "pick", kind: "team", id: "7", name: "#backend" },
      role: "reviewer",
      permission: "ask",
      start: "review",
      template: "Fix {{ID}}",
      repoMap: { "shop-admin": ["shop-admin", "shop-backend"], single: ["shop-pos"] },
    });
  });

  it("never lets a bypass mode or an odd assignee through", () => {
    expect(parsePrefs({ permission: "bypass" }).permission).toBe("edit");
    expect(parsePrefs({ assignee: { mode: "pick", kind: "user", id: "4; drop", name: "x" } }).assignee).toEqual({ mode: "me" });
    expect(parsePrefs({ assignee: { mode: "pick", kind: "admin", id: "4" } }).assignee).toEqual({ mode: "me" });
    expect(parsePrefs({ assignee: { mode: "none" } }).assignee).toEqual({ mode: "none" });
  });
});
