import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionItem } from "../../store/agent-reducer";
import { installDomStubs } from "../../store/testing-u2";
import { PermissionCard } from "./Cards";
import { setLocale } from "../../i18n";

installDomStubs();
// CSS is off in the test run, so a `?raw` stylesheet arrives empty: the files are read from disk (vitest runs in `ui/`).
const fsName = "node:fs";
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(path: string, encoding: "utf8"): string };
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const chatCss = fs.readFileSync(`${cwd}/src/components/chat/chat.css`, "utf8");
const modesCss = fs.readFileSync(`${cwd}/src/components/chat/modes.css`, "utf8");
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await setLocale("en", { persist: false });
});

/** The declarations of the rule whose selector list is exactly `selector` (comments removed). */
function rule(css: string, selector: string): string {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(plain);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[2];
}

describe("the request card's layout rules are in the stylesheet (a CSS-only change must not break them unseen)", () => {
  it("the card is never taller than the visible transcript and its middle scrolls inside it", () => {
    expect(chatCss.length).toBeGreaterThan(1000);
    expect(rule(chatCss, ".perm")).toMatch(/max-height:\s*var\(--perm-max/);
    expect(rule(chatCss, ".perm")).toMatch(/flex-direction:\s*column/);
    const body = rule(chatCss, ".perm__body");
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).toMatch(/min-height:/);
    // the top (title, what is asked) and the foot (the buttons) never shrink or scroll
    expect(rule(chatCss, ".perm__top, .perm__foot")).toMatch(/flex:\s*none/);
    // the plan's own box does not scroll a second time inside the middle
    expect(modesCss).toMatch(/\.plan-approval \.perm__body > \.plan-approval__text \{[^}]*overflow:\s*visible/);
  });
});

describe("the 'Scroll for more' cue", () => {
  /** A ResizeObserver that reports at once, and a middle 100 px tall with 300 px of content. */
  function overflowing() {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {}
        observe() {
          queueMicrotask(() => this.cb());
        }
        disconnect() {}
        unobserve() {}
      },
    );
    for (const [k, v] of [["scrollHeight", 300], ["clientHeight", 100]] as const) {
      Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get(this: HTMLElement) { return this.classList.contains("perm__body") ? v : 0; } });
    }
  }
  const item: PermissionItem = { key: "p", ts: 1, type: "permission", reqId: "more-1", toolId: "t", intent: { class: "exec", rawCommand: "pnpm install", summary: "Run `pnpm install`" }, options: ["allowOnce", "deny"] };

  it("shows under a middle that has more below, names it as the middle's description, and goes once scrolled to the end", async () => {
    overflowing();
    render(() => <PermissionCard item={item} onAnswer={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
    const cue = screen.getByTestId("perm-more");
    expect(cue.textContent).toBe("Scroll for more");
    const body = document.querySelector<HTMLElement>(".perm__body")!;
    expect(body.hasAttribute("data-more")).toBe(true);
    expect(body.getAttribute("aria-describedby")).toBe(cue.id);
    // the cue sits in the foot, which never scrolls
    expect(cue.closest(".perm__foot")).toBeTruthy();
    body.scrollTop = 200;
    fireEvent.scroll(body);
    expect(screen.queryByTestId("perm-more")).toBeNull();
    expect(body.hasAttribute("data-more")).toBe(false);
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  });

  it("speaks Hungarian", async () => {
    await setLocale("hu", { persist: false });
    overflowing();
    render(() => <PermissionCard item={item} onAnswer={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId("perm-more").textContent).toBe("Görgess tovább");
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  });
});
