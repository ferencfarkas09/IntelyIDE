import { describe, expect, it } from "vitest";
import type { TimerView, Trackable } from "../../ipc/happy";
import { IDLE_TIMER } from "../../store/happy";
import { buildRows, createErrorKey, elapsedSec, filterEntries, formatClock, formatTotal, groupSearch, groupTrackables, isCurrentRange, isTarget, knownProjects, rangeOf, shiftAnchor, startOfWeek, todayRange, windowRows } from "./logic";

const running: TimerView = { ...IDLE_TIMER, phase: "running", targetId: "p1", taskId: "t1", title: "Receipts", startedAtMs: 1_000_000, accumulatedSec: 60 };

describe("elapsedSec", () => {
  it("adds the time since the start to what was counted before", () => {
    expect(elapsedSec(running, 1_000_000 + 90_500)).toBe(150);
  });
  it("corrects a wrong local clock with the server offset", () => {
    expect(elapsedSec({ ...running, offsetMs: 10_000 }, 1_000_000 + 90_000)).toBe(160);
  });
  it("counts a break segment from its own start, like running", () => {
    expect(elapsedSec({ ...running, phase: "break", accumulatedSec: 0 }, 1_000_000 + 30_000)).toBe(30);
  });
  it("freezes while paused and is zero while idle, and never goes negative", () => {
    expect(elapsedSec({ ...running, phase: "paused" }, 9_999_999)).toBe(60);
    expect(elapsedSec(IDLE_TIMER, 9_999_999)).toBe(0);
    expect(elapsedSec(running, 0)).toBe(60);
  });
});

describe("formatting", () => {
  it("shows hours, minutes and seconds with leading zeros", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(5025)).toBe("01:23:45");
    expect(formatClock(100 * 3600)).toBe("100:00:00");
  });
  it("shows a total as hours and minutes", () => {
    expect(formatTotal(5 * 3600 + 12 * 60 + 59)).toBe("5h 12m");
    expect(formatTotal(42 * 60)).toBe("42m");
    expect(formatTotal(10)).toBe("0m");
  });
});

describe("trackables", () => {
  const all: Trackable[] = [
    { kind: "project", id: "p1", taskId: "t1", title: "Receipts", project: "Shop POS" },
    { kind: "project", id: "p1", taskId: "t2", title: "Refunds", project: "Shop POS" },
    { kind: "workOrder", id: "w1", title: "Fix the till printer" },
  ];
  it("groups by project and puts work orders under their own heading", () => {
    expect(groupTrackables(all, "").map((g) => [g.project, g.items.length])).toEqual([["Shop POS", 2], ["Work orders", 1]]);
  });
  it("filters on title and project, ignoring case", () => {
    expect(groupTrackables(all, "REFU").flatMap((g) => g.items.map((i) => i.title))).toEqual(["Refunds"]);
    expect(groupTrackables(all, "shop").flatMap((g) => g.items).length).toBe(2);
    expect(groupTrackables(all, "zzz")).toEqual([]);
  });
  it("recognises the running target by id and task", () => {
    expect(isTarget(running, all[0])).toBe(true);
    expect(isTarget(running, all[1])).toBe(false);
    expect(isTarget(IDLE_TIMER, all[0])).toBe(false);
  });
});

describe("todayRange", () => {
  it("is local midnight to the next local midnight", () => {
    const noon = new Date(2026, 9, 3, 12, 0).getTime();
    const [from, to] = todayRange(noon);
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(to).getDate()).toBe(4);
    expect(from <= noon && noon < to).toBe(true);
  });
});

describe("ranges", () => {
  const wed = new Date(2026, 9, 7, 15, 30).getTime(); // Wednesday 7 October 2026
  it("a week runs Monday to the next Monday and a month from the 1st", () => {
    const [from, to] = rangeOf("week", wed);
    expect([new Date(from).getDay(), new Date(from).getDate(), new Date(to).getDate(), new Date(to).getDay()]).toEqual([1, 5, 12, 1]);
    const [m0, m1] = rangeOf("month", wed);
    expect([new Date(m0).getDate(), new Date(m0).getMonth(), new Date(m1).getDate(), new Date(m1).getMonth()]).toEqual([1, 9, 1, 10]);
    expect(new Date(startOfWeek(new Date(2026, 9, 4).getTime())).getDate()).toBe(28); // a Sunday belongs to the week before
  });
  it("steps by a day, a week or a month, across month ends", () => {
    expect(new Date(shiftAnchor("day", new Date(2026, 9, 1).getTime(), -1)).getDate()).toBe(30);
    expect(new Date(shiftAnchor("week", wed, 1)).getDate()).toBe(14);
    const prev = new Date(shiftAnchor("month", new Date(2026, 0, 31).getTime(), -1));
    expect([prev.getFullYear(), prev.getMonth(), prev.getDate()]).toEqual([2025, 11, 1]);
  });
  it("knows when the range holds now", () => {
    expect(isCurrentRange("week", wed, wed + 86_400_000)).toBe(true);
    expect(isCurrentRange("day", wed, wed + 86_400_000)).toBe(false);
    expect(isCurrentRange("month", shiftAnchor("month", wed, -1), wed)).toBe(false);
  });
});

describe("the entry list", () => {
  const at = (day: number, h: number) => new Date(2026, 9, day, h).getTime();
  const entry = (id: string, title: string, started: number, seconds: number, project?: string) => ({ id, title, project, startedAtMs: started, endedAtMs: started + seconds * 1000, seconds, abandoned: false });
  const list = [entry("a", "Shop POS", at(7, 11), 600, "Acme"), entry("b", "Admin", at(7, 9), 1200), entry("c", "Árvíztűrő", at(6, 9), 60, "Kiss Kft."), { ...entry("d", "Admin", at(5, 9), 0), endedAtMs: undefined }];
  it("groups entries under their day with the day's total", () => {
    const rows = buildRows(list);
    expect(rows.map((r) => r.type)).toEqual(["day", "entry", "entry", "day", "entry", "day", "entry"]);
    expect(rows.filter((r) => r.type === "day").map((r) => (r.type === "day" ? [r.seconds, r.running] : []))).toEqual([[1800, undefined], [60, undefined], [0, 0]]);
  });
  it("filters on title and project, ignoring case and accents", () => {
    expect(filterEntries(list, "arvizt").map((e) => e.id)).toEqual(["c"]);
    expect(filterEntries(list, "ACME").map((e) => e.id)).toEqual(["a"]);
    expect(filterEntries(list, "  ").length).toBe(4);
  });
  it("windows fixed-height rows with an overscan", () => {
    expect(windowRows(1000, 0, 400, 40, 5)).toEqual({ start: 0, end: 15 });
    expect(windowRows(1000, 4000, 400, 40, 5)).toEqual({ start: 95, end: 115 });
    expect(windowRows(10, 100000, 400, 40)).toEqual({ start: 10, end: 10 });
  });
});

describe("search results", () => {
  const found = {
    projects: [{ id: "p1", title: "Shop POS", code: "HP", customer: "Acme" }, { id: "p3", title: "Empty project" }],
    tasks: [
      { kind: "project", id: "p1", taskId: "t1", title: "Receipts", project: "Shop POS" },
      { kind: "project", id: "p1", taskId: "t1", title: "Receipts", project: "Shop POS" },
      { kind: "project", id: "p2", taskId: "t9", title: "Orphan", project: "Admin" },
      { kind: "project", id: "p4", taskId: "t7", title: "No project title" },
    ],
  };
  it("groups tasks under their project, projects without a task included, and drops duplicates", () => {
    expect(groupSearch(found).map((g) => [g.projectId, g.project, g.customer, g.items.length])).toEqual([["p1", "Shop POS", "Acme", 1], ["p3", "Empty project", undefined, 0], ["p2", "Admin", undefined, 1], ["p4", "Other", undefined, 1]]);
  });
  it("lists the projects a new task can go into", () => {
    expect(knownProjects([{ kind: "workOrder", id: "w", title: "WO" }, { kind: "project", id: "p9", title: "Backend" }], found).map((p) => p.title)).toEqual(["Admin", "Backend", "Empty project", "Shop POS"]);
  });
  it("maps the create-task failures to plain messages", () => {
    expect([createErrorKey("rejected"), createErrorKey("forbidden"), createErrorKey("notFound"), createErrorKey("blocked"), createErrorKey("offline"), createErrorKey("weird"), createErrorKey(undefined)]).toEqual([
      "htm.new.err.rejected", "htm.new.err.forbidden", "htm.new.err.notFound", "htm.new.err.blocked", "htm.new.err.offline", "htm.new.err.generic", "htm.new.err.generic",
    ]);
  });
});
