import { describe, expect, it } from "vitest";
import type { SentryDetail, SentryIssue } from "../sentry/types";
import { buildPrompt, DEFAULT_TEMPLATE, factsBlock, fixPrompt, isDefaultTemplate, MAX_PROMPT_CHARS, parseVerdict, placeholderOf, renderTemplate, stackBlock, stackHint, tagsBlock, trailBlock } from "./prompt";

const issue: SentryIssue = {
  id: "11", shortId: "SHOP-B", title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: "src/api/orders.js in loadOrder", level: "error", status: "unresolved",
  count: 412, userCount: 63, firstSeen: "2026-09-25T10:00:00Z", lastSeen: "2026-10-07T20:00:00Z", permalink: "https://sentry.io/organizations/acme/issues/11/",
  project: { id: "5", slug: "shop-backend", name: "Shop Backend" }, assignedTo: null, errorType: "TypeError", errorValue: "Cannot read", isUnhandled: true,
};

const detail: SentryDetail = {
  issue,
  event: {
    eventId: "e1", dateCreated: "2026-10-07T20:00:00Z", platform: "node", release: "shop@2026.10.3", environment: "production", message: "boom",
    tags: [{ key: "browser", value: "Safari 18" }, { key: "os", value: "macOS 15" }, { key: "release", value: "shop@2026.10.3" }, { key: "colour", value: "green" }],
    requestUrl: "https://shop.example.invalid/api/orders/7",
    exceptions: [{ kind: "TypeError", value: "x is undefined", frames: [
      { filename: "node_modules/express/router.js", function: "handle", line: 10, inApp: false, context: [] },
      { filename: "src/api/middleware/auth.js", function: "requireUser", line: 31, inApp: true, context: [{ line: 30, code: "const user = await find(token);" }, { line: 31, code: "req.user = user;" }] },
      { filename: "src/api/orders.js", function: "loadOrder", line: 42, inApp: true, context: [{ line: 41, code: "const o = await db.find(id);" }, { line: 42, code: "  return o.id;  " }, { line: 43, code: "}" }] },
    ] }],
    breadcrumbs: [{ timestamp: "t", category: "http", message: "GET /orders/7", level: "info" }, { timestamp: "t", category: "", message: "", level: "info" }],
  },
};

describe("buildPrompt (the default template)", () => {
  const p = fixPrompt({ detail, repos: { primary: ["shop-backend"], related: ["shop-admin"] }, branch: "main" });

  it("names the issue first, so a run started from the dialog can be found again by its title", () => {
    expect(p.split("\n")[0]).toBe("Fix the Sentry issue SHOP-B: TypeError: Cannot read properties of undefined (reading 'id')");
  });

  it("says where it is, how often, since when and in which release", () => {
    expect(p).toContain("- Where: src/api/orders.js in loadOrder (Sentry project shop-backend)");
    expect(p).toContain("- Seen 412 times by 63 users, first 2026-09-25T10:00:00Z, last 2026-10-07T20:00:00Z");
    expect(p).toContain("unhandled");
    expect(p).toContain("- Release: shop@2026.10.3, environment production");
    expect(p).toContain("- Request: https://shop.example.invalid/api/orders/7");
  });

  it("shows the app's own frames, the failing one last, the code around the two innermost and the failing line marked", () => {
    expect(p).toContain("TypeError: x is undefined");
    expect(p).toContain("at loadOrder (src/api/orders.js:42)");
    expect(p).not.toContain("node_modules/express");
    expect(p).toContain("      > 42|   return o.id;");
    expect(p).toContain("        41| const o = await db.find(id);");
    expect(p).toContain("      > 31| req.user = user;");
    expect(p.indexOf("at requireUser")).toBeLessThan(p.indexOf("at loadOrder"));
  });

  it("lists the last steps and leaves out the empty ones", () => {
    expect(p).toContain("What happened right before:\n  - [http] GET /orders/7");
    expect(p.match(/^ {2}- /gm)).toHaveLength(1);
  });

  it("names the repositories, the one the work is in and the ones that may change with it", () => {
    expect(p).toContain("Work in shop-backend. Also in scope: shop-admin.");
    expect(p).toContain("fix it at the source there as well");
  });

  it("gives the rules of the work and ends on the verdict lines and the link", () => {
    expect(p).toMatch(/Do not commit, push, branch/);
    expect(p).toContain("INTELYFIX: fixed | needs-triage");
    expect(p).toContain("This is server code");
    expect(p.trimEnd().endsWith("Sentry: https://sentry.io/organizations/acme/issues/11/")).toBe(true);
    expect(p).not.toMatch(/\{\{/);
    expect(p).not.toMatch(/\n{3,}/);
  });

  it("still reads well for an issue whose newest event could not be read, and for one seen once by one user", () => {
    const text = fixPrompt({ detail: { issue: { ...issue, count: 1, userCount: 1, isUnhandled: false, project: null }, event: null } });
    expect(text).toContain("Seen 1 time by 1 user,");
    expect(text).not.toContain("unhandled");
    expect(text).not.toContain("(Sentry project");
    expect(text).toContain("Find the root cause");
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe("the blocks", () => {
  it("falls back to the library frames when none is the app's own, and to the message when there is no exception", () => {
    const only = { ...detail.event!, exceptions: [{ kind: "E", value: "v", frames: [{ filename: "lib/a.js", function: "f", line: 1, inApp: false, context: [] }] }] };
    expect(stackBlock(only)).toContain("at f (lib/a.js:1)  [library]");
    expect(stackBlock({ ...detail.event!, exceptions: [] })).toBe("Message: boom");
    expect(stackBlock(null)).toBe("");
  });

  it("tells a regression, an escalating and a new issue apart, and quotes the priority", () => {
    expect(factsBlock({ ...issue, substatus: "regressed", priority: "high" }, null)).toMatch(/high priority[\s\S]*It is a regression: it was resolved before/);
    expect(factsBlock({ ...issue, substatus: "escalating" }, null)).toContain("escalating");
    expect(factsBlock({ ...issue, substatus: "new" }, null)).toContain("It is new");
    expect(factsBlock({ ...issue, substatus: "ongoing" }, null)).not.toMatch(/regression|escalating|It is new/);
  });

  it("keeps the tags that say where it happens and drops the rest", () => {
    expect(tagsBlock(detail.event)).toBe("Tags: browser=Safari 18, os=macOS 15");
    expect(tagsBlock(null)).toBe("");
    expect(trailBlock(null)).toBe("");
  });

  it("advises by the kind of app and says nothing when it does not know", () => {
    expect(stackHint("node", "shop-backend")).toContain("server code");
    expect(stackHint("javascript-react", "shop-admin")).toContain("front-end code");
    expect(stackHint("javascript", "services-app")).toContain("mobile app");
    expect(stackHint("react-native")).toContain("never start a native build");
    expect(stackHint("cobol", "legacy")).toBe("");
  });
});

describe("templates", () => {
  it("fills placeholders in any case, with the names of the first auto-fixer too, and reports the ones it does not know", () => {
    const r = renderTemplate("{{SHORT_ID}} / {{ title }} / {{permalink}} / {{nope}} / {{NOPE}}", { ID: "A-1", TITLE: "boom", LINK: "https://x" });
    expect(r.text).toBe("A-1 / boom / https://x /  /");
    expect(r.unknown).toEqual(["nope", "NOPE"]);
    expect(placeholderOf("event")).toBe("EVENT_JSON");
    expect(placeholderOf("Short_Id")).toBe("ID");
    expect(placeholderOf("whatever")).toBeUndefined();
  });

  it("uses a custom template and drops the blank lines an empty placeholder leaves", () => {
    const text = fixPrompt({ detail, template: "Fix {{ID}}.\n\n{{REPOS}}\n\n{{TAGS}}\n\nBranch {{BASE_BRANCH}}.", branch: "dev" });
    expect(text).toBe("Fix SHOP-B.\n\nTags: browser=Safari 18, os=macOS 15\n\nBranch dev.");
  });

  it("treats an empty or whitespace template as the built-in one", () => {
    expect(fixPrompt({ detail, template: "   " })).toBe(fixPrompt({ detail }));
    expect(isDefaultTemplate("")).toBe(true);
    expect(isDefaultTemplate(`  ${DEFAULT_TEMPLATE}\n`)).toBe(true);
    expect(isDefaultTemplate("my own")).toBe(false);
  });

  it("can put the event as JSON in, slimmed", () => {
    const text = fixPrompt({ detail, template: "{{EVENT_JSON}}" });
    expect(JSON.parse(text)).toMatchObject({ eventId: "e1", platform: "node" });
  });

  it("keeps a huge event under the cap by cutting the stack and the trail first", () => {
    const big = { ...detail.event!, exceptions: [{ kind: "E", value: "v", frames: Array.from({ length: 30 }, (_, i) => ({ filename: `src/f${i}.js`, function: `fn${i}`, line: i + 1, inApp: true, context: [{ line: i + 1, code: "x".repeat(190) }] })) }], breadcrumbs: Array.from({ length: 15 }, (_, i) => ({ timestamp: "t", category: "c", message: `step ${i} ${"y".repeat(190)}`, level: "info" })) };
    const built = buildPrompt({ detail: { issue, event: big }, template: `${DEFAULT_TEMPLATE}\n${"padding ".repeat(1000)}` });
    expect(built.text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    const lean = buildPrompt({ detail: { issue, event: big } });
    expect(lean.text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(lean.text).toContain("INTELYFIX: fixed | needs-triage");
    expect(lean.trimmed).toBe(false);
  });
});

describe("parseVerdict", () => {
  it("reads the last verdict line and the cause under it", () => {
    expect(parseVerdict("I looked.\nINTELYFIX: fixed\nCause: the order was undefined when the id was read.\nChanged orders.js.")).toEqual({ verdict: "fixed", cause: "the order was undefined when the id was read." });
    expect(parseVerdict("INTELYFIX: needs-triage\nCause: a Mongo outage")).toEqual({ verdict: "needs-triage", cause: "a Mongo outage" });
    expect(parseVerdict("INTELYFIX: fixed | needs-triage\n...\nINTELYFIX: needs-triage")?.verdict).toBe("needs-triage");
  });

  it("is undefined when the agent did not give one", () => {
    expect(parseVerdict("All done, fixed it.")).toBeUndefined();
    expect(parseVerdict("")).toBeUndefined();
    expect(parseVerdict("intelyfix: maybe")).toBeUndefined();
  });
});
