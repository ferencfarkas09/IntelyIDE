import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { ModeBanner } from "./Banners";

installDomStubs();
afterEach(cleanup);

describe("<ModeBanner>", () => {
  it("says a resume dropped Bypass, and offers no way back into it", () => {
    render(() => <ModeBanner banner={{ kind: "resumeDowngrade", seq: 4 }} mode="automatic" onDismiss={() => {}} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("This run was in Bypass. Bypass is never carried over, so it continues in Automatic.");
    expect(banner.getAttribute("data-tone")).toBe("warn");
    expect(screen.queryByRole("button", { name: /Bypass/ })).toBeNull();
  });

  it("names the mode a changed role file narrowed the run to", () => {
    render(() => <ModeBanner banner={{ kind: "roleChanged", seq: 4 }} mode="ask" onDismiss={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("This run's role file changed or is no longer trusted, so it continues in Ask.");
  });

  it("says when the build has switched Automatic and Bypass off", () => {
    render(() => <ModeBanner banner={{ kind: "providerLimit", seq: 4 }} mode="ask" onDismiss={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Automatic and Bypass are switched off in this build; the run continues in Ask.");
  });

  it("can be dismissed with a button", () => {
    const onDismiss = vi.fn();
    render(() => <ModeBanner banner={{ kind: "resumeDowngrade", seq: 4 }} mode="automatic" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
