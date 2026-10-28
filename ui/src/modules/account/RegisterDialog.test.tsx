import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { resetWhatsNew, showUpdate } from "../whatsnew/state";
import { setRegistryApi, type RegistryApi } from "./api";
import RegisterDialog from "./RegisterDialog";
import { dialog, resetAccount, setSettleMs, status } from "./store";
import type { RegistryStatus } from "./types";

installDomStubs();

const base: RegistryStatus = { state: "unasked", name: null, email: null, newsletter: null, notice: "2026-10-23", consentedNotice: null, needsConsent: true, url: "https://api.example.invalid" };
const registered: RegistryStatus = { ...base, state: "registered", name: "Anna", email: "anna@example.com", newsletter: "none", consentedNotice: "2026-10-23", needsConsent: false };

function fake(initial: RegistryStatus, over: Partial<RegistryApi> = {}) {
  let current = initial;
  const api = {
    status: vi.fn(async () => current),
    register: vi.fn(async () => (current = registered)),
    decline: vi.fn(async () => (current = { ...current, state: "declined", needsConsent: false } as RegistryStatus)),
    me: vi.fn(),
    newsletter: vi.fn(),
    forget: vi.fn(),
    reconsent: vi.fn(async (accept: boolean) => (current = accept ? { ...current, consentedNotice: "2026-10-23", needsConsent: false } : { ...base, state: "declined", needsConsent: false })),
    openExternal: vi.fn(async () => {}),
    ...over,
  } as unknown as RegistryApi & { [K in keyof RegistryApi]: ReturnType<typeof vi.fn> };
  setRegistryApi(api);
  return api;
}

beforeEach(() => {
  resetAccount();
  resetWhatsNew();
  setSettleMs(5);
});
afterEach(() => {
  cleanup();
  setRegistryApi(undefined);
  resetWhatsNew();
});

const fill = (name: string, email: string) => {
  fireEvent.input(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.input(screen.getByLabelText("Email"), { target: { value: email } });
};

describe("the first-start screen", () => {
  it("asks once, says exactly what is stored, and starts with both boxes unticked", async () => {
    fake(base);
    render(() => <RegisterDialog />);
    const d = await screen.findByRole("dialog", { name: "Register this computer?" });
    expect(d.textContent).toContain("your name and email address");
    expect(d.textContent).toContain("a fingerprint of this computer (a hash, not the machine id)");
    expect(d.textContent).toContain("the country, region and city your internet connection suggests (not the IP address itself)");
    expect(d.textContent).toContain("Never stored: your IP address, your files, repositories, prompts, answers");
    expect(d.textContent).toContain("https://api.example.invalid");
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false]);
  });

  it("registers with the agreement, the newsletter choice and the language of the webview", async () => {
    const api = fake(base);
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fill(" Anna ", "Anna@Example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree that this is stored/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Send me the IntelyIDE newsletter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(api.register).toHaveBeenCalledOnce());
    const sent = api.register.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: " Anna ", email: "Anna@Example.com", newsletter: true, consent: true });
    expect(typeof sent.locale).toBe("string");
    expect(typeof sent.tz).toBe("string");
    await waitFor(() => expect(dialog()).toBeUndefined());
    expect(status()?.state).toBe("registered");
  });

  it("sends nothing without the agreement or with bad input, and says why", async () => {
    const api = fake(base);
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect((await screen.findAllByRole("alert")).map((a) => a.textContent)).toEqual(expect.arrayContaining(["Enter your name.", "Enter a valid email address.", "Tick the agreement to register."]));
    fill("Anna", "not-an-address");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree that this is stored/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(screen.getByText("Enter a valid email address.")).toBeTruthy());
    expect(api.register).not.toHaveBeenCalled();
  });

  it("keeps the screen open and explains when the registry cannot be reached", async () => {
    const api = fake(base, { register: vi.fn(async () => Promise.reject({ code: "offline", message: "x" })) });
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fill("Anna", "anna@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree that this is stored/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText("The registry could not be reached. Check the connection and try again.")).toBeTruthy();
    expect(api.register).toHaveBeenCalledOnce();
    expect(dialog()).toBe("register");
  });

  it("says the registry is unavailable in the person's language when the host answers something unexpected", async () => {
    const api = fake(base, { register: vi.fn(async () => Promise.reject({ code: "badResponse", message: "The registry answered with 404" })) });
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fill("Anna", "anna@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree that this is stored/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText("The registry is not available right now. Try again a little later.")).toBeTruthy();
    expect(screen.queryByText(/answered with 404/)).toBeNull();
    expect(api.register).toHaveBeenCalledOnce();
    expect(dialog()).toBe("register");
  });

  it.each([
    ["unknownInstall", "The registry does not know this computer (any more)", "The registry does not know this computer any more. Register it again."],
    ["badRequest", "The registry did not accept the request (email)", "The registry did not accept the request. Update IntelyIDE and try again."],
  ])("shows the registry's %s answer in the person's language, not as the server's English", async (code, raw, words) => {
    fake(base, { register: vi.fn(async () => Promise.reject({ code, message: raw })) });
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fill("Anna", "anna@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree that this is stored/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.queryByText(raw, { exact: false })).toBeNull();
  });

  it("accepts an address with an apostrophe, which the registry and the app accept too", async () => {
    const api = fake(base);
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fill("Anna O'Brien", "o'brien@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree that this is stored/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(api.register).toHaveBeenCalledOnce());
    expect((api.register.mock.calls[0][0] as { email: string }).email).toBe("o'brien@example.com");
  });

  it("does not take Escape for 'Not now' while the request is in flight: its answer decides", async () => {
    let release: () => void = () => {};
    const api = fake(base, { register: vi.fn(() => new Promise<RegistryStatus>((resolve) => (release = () => resolve(registered)))) });
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fill("Anna", "anna@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree that this is stored/ }));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(api.register).toHaveBeenCalledOnce());
    fireEvent.keyDown(document, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(api.decline).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(dialog()).toBeUndefined());
    expect(status()?.state).toBe("registered");
  });

  it("treats Not now and Escape as the same answer: nothing is sent and it is remembered", async () => {
    const api = fake(base);
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(api.decline).toHaveBeenCalledOnce());
    expect(api.register).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not open for someone who was asked already", async () => {
    const api = fake({ ...base, state: "declined", needsConsent: false });
    render(() => <RegisterDialog />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits for the What's new window instead of opening on top of it", async () => {
    fake(base);
    showUpdate("1.13.0", "1.12.0");
    render(() => <RegisterDialog />);
    await new Promise((r) => setTimeout(r, 60));
    expect(dialog()).toBeUndefined();
    resetWhatsNew();
    await screen.findByRole("dialog", { name: "Register this computer?" });
  });
});

describe("a changed notice", () => {
  const again: RegistryStatus = { ...registered, consentedNotice: "2025-01-01", needsConsent: true };

  it("asks the registered person again, and continuing keeps the registration", async () => {
    const api = fake(again);
    render(() => <RegisterDialog />);
    const d = await screen.findByRole("dialog", { name: "The privacy notice changed" });
    expect(d.textContent).toContain("nothing is sent until you answer");
    fireEvent.click(screen.getByRole("button", { name: "Continue sharing" }));
    await waitFor(() => expect(api.reconsent).toHaveBeenCalledWith(true, expect.any(String), expect.any(String)));
    await waitFor(() => expect(dialog()).toBeUndefined());
  });

  it("stopping deletes everything", async () => {
    const api = fake(again);
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog", { name: "The privacy notice changed" });
    fireEvent.click(screen.getByRole("button", { name: "Stop and delete my data" }));
    await waitFor(() => expect(api.reconsent).toHaveBeenCalledWith(false, expect.any(String), expect.any(String)));
    await waitFor(() => expect(status()?.state).toBe("declined"));
  });

  it("closing it without an answer changes nothing, so it is asked again next start", async () => {
    const api = fake(again);
    render(() => <RegisterDialog />);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeUndefined());
    expect(api.reconsent).not.toHaveBeenCalled();
    expect(api.decline).not.toHaveBeenCalled();
  });
});
