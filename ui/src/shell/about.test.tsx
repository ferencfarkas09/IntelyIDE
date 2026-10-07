import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../modules/settings-core/DoctorChecks", () => ({ default: () => null }));
vi.mock("../ipc", async (orig) => {
  const real = await orig<typeof import("../ipc")>();
  return { ...real, ipc: { ...real.ipc, providers: { ...real.ipc.providers, doctor: () => Promise.resolve([]) } } };
});

import AboutSection from "../modules/settings-core/AboutSection";
import { AboutDialog, openAbout } from "./AboutDialog";
import { ABOUT } from "./aboutText";
import { closeLicenses, licensesState } from "./licenses/open";

const mutable = ABOUT as { source: string | undefined };

describe("About license card", () => {
  let open: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    open = vi.spyOn(window, "open").mockReturnValue(null);
    closeLicenses();
  });
  afterEach(() => {
    cleanup();
    open.mockRestore();
    mutable.source = undefined;
  });

  it("the dialog footer button is enabled and opens the licenses view", async () => {
    render(() => <AboutDialog />);
    openAbout();
    const button = await screen.findByRole("button", { name: "Open-source licenses" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(licensesState().ever).toBe(false);
    fireEvent.click(button);
    expect(licensesState()).toMatchObject({ open: true, ever: true, select: undefined });
  });

  it("opening the licenses closes About instead of stacking under it", async () => {
    render(() => <AboutDialog />);
    openAbout();
    fireEvent.click(await screen.findByRole("button", { name: "Open-source licenses" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open-source licenses" })).toBeNull());
  });

  it("shows one copyright line, with the license holder", async () => {
    render(() => <AboutDialog />);
    openAbout();
    await screen.findByText("GPL-3.0-or-later");
    const lines = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent!.includes("©"));
    expect(lines.map((e) => e.textContent)).toEqual([`© ${ABOUT.year} ${ABOUT.holder}`]);
  });

  it("shows the chip, the 5(d) notice and the copyright, and 'View full text' selects the project entry", async () => {
    render(() => <AboutDialog />);
    openAbout();
    const chip = await screen.findByText("GPL-3.0-or-later");
    expect(chip.textContent).toBe("GPL-3.0-or-later");
    expect(screen.getByText(/any later version/).textContent).toContain("ABSOLUTELY NO WARRANTY");
    expect(screen.getByText(/IntelyIDE contributors/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View full text" }));
    expect(licensesState()).toMatchObject({ open: true, select: "project" });
  });

  it("opens gnu.org through openLink (https only) and hides the Source code row until a URL is set", async () => {
    render(() => <AboutDialog />);
    openAbout();
    fireEvent.click(await screen.findByRole("button", { name: /Open on gnu\.org/ }));
    expect(open).toHaveBeenCalledWith("https://www.gnu.org/licenses/gpl-3.0.html", "_blank", "noopener,noreferrer");
    expect(ABOUT.license.url.startsWith("https://")).toBe(true);
    expect(screen.queryByText("Source code")).toBeNull();
  });

  it("shows the Source code row as an https link once the URL is set", async () => {
    mutable.source = "https://github.com/IntelyHome/example";
    render(() => <AboutDialog />);
    openAbout();
    const link = await screen.findByRole("button", { name: /github\.com/ });
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://github.com/IntelyHome/example", "_blank", "noopener,noreferrer");
    expect(screen.getByText("Source code")).toBeTruthy();
  });

  it("Settings > About shows the same card and an Open-source licenses button", async () => {
    render(() => <AboutSection />);
    expect(await screen.findByText("GPL-3.0-or-later")).toBeTruthy();
    expect(screen.getByText(/any later version/)).toBeTruthy();
    expect(screen.queryByText("Source code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open-source licenses" }));
    expect(licensesState().open).toBe(true);
  });
});
