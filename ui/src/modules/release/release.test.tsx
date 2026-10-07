import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { createMockRelease, setReleaseApi } from "./api";
import { dropItem, entryCount, mergeTranslations, setEnglish, translationJobs } from "./logic";
import ReleaseTab from "./ReleaseTab";

installDomStubs();
afterEach(() => {
  cleanup();
  setReleaseApi(undefined);
});

const tab = { id: "release", type: "release", title: "Release", params: { repoId: "r" } };
const plan = () => createMockRelease().plan("r");

describe("release logic", () => {
  it("makes one translation job per missing language and puts valid answers back", async () => {
    const { entry, langs } = await plan();
    const jobs = translationJobs(entry, langs);
    expect(jobs).toHaveLength((1 + entryCount(entry)) * (langs.length - 1));
    const out = mergeTranslations(entry, [
      { id: jobs[0].id, text: "Ez a kiadás", valid: true },
      { id: jobs[1].id, text: "", valid: false },
    ]);
    expect(out).toMatchObject({ applied: 1, skipped: 1 });
    expect(out.entry.highlight.hu).toBe("Ez a kiadás");
    expect(entry.highlight.hu).toBeUndefined();
    // A language that has its text is not asked again.
    expect(translationJobs(out.entry, langs).some((j) => j.id === jobs[0].id)).toBe(false);
  });

  it("edits the English text and leaves an item out", async () => {
    const { entry } = await plan();
    expect(setEnglish(entry, { gi: 0, ii: 0, field: "title" }, "Edited").groups[0].items[0].title.en).toBe("Edited");
    const fewer = dropItem(dropItem(entry, 1, 0), 0, 0);
    expect(entryCount(fewer)).toBe(entryCount(entry) - 2);
    expect(fewer.groups.map((g) => g.type)).toEqual(["feature", "fix"]);
  });
});

describe("<ReleaseTab>", () => {
  it("shows the proposal and the exact diff, writes nothing until Apply, then applies the edited entry", async () => {
    const api = createMockRelease();
    const sent: unknown[] = [];
    setReleaseApi({ ...api, apply: async (r, req) => (sent.push(req), api.apply(r, req)) });
    render(() => <ReleaseTab tab={tab} />);
    await waitFor(() => expect(screen.getByText("3.89.0")).toBeTruthy());
    expect(screen.getByText("3.88.7")).toBeTruthy();
    expect(document.querySelector(".rel__pre")!.textContent).toContain('+  "version": "3.89.0"');
    expect(sent).toHaveLength(0);
    fireEvent.input(screen.getByLabelText("Title feature 1"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByText(/Apply version 3.89.0/));
    await waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { version: string; entry: { groups: { items: { title: { en: string } }[] }[] }; changelogPath: string };
    expect(req.version).toBe("3.89.0");
    expect(req.entry.groups[0].items[0].title.en).toBe("Edited title");
    expect(req.changelogPath).toContain("changelog.json");
    await waitFor(() => expect(screen.getByText(/Updated package.json and/)).toBeTruthy());
    expect((screen.getByText(/Apply version/).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-plans with the chosen bump", async () => {
    render(() => <ReleaseTab tab={tab} />);
    await waitFor(() => expect(screen.getByText("3.89.0")).toBeTruthy());
    fireEvent.click(screen.getByText("Patch"));
    await waitFor(() => expect(screen.getByText("3.88.8")).toBeTruthy());
  });

  it("translates the entry only on request", async () => {
    render(() => <ReleaseTab tab={tab} />);
    await waitFor(() => expect(screen.getByText("3.89.0")).toBeTruthy());
    expect(screen.queryByText(/translations/)).toBeNull();
    fireEvent.click(screen.getByText(/Translate to 10 languages/));
    await waitFor(() => expect(screen.getAllByText(/\+ 10 translations/).length).toBeGreaterThan(0));
  });

  it("shows a planning failure as text", async () => {
    setReleaseApi({ ...createMockRelease(), plan: async () => Promise.reject({ code: "noVersion", message: "no package.json with a version" }) });
    render(() => <ReleaseTab tab={tab} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no package.json"));
  });
});
