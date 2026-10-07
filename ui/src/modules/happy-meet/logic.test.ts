import { describe, expect, it } from "vitest";
import type { Meeting } from "../../ipc/happy";
import { relevantMeeting } from "../../store/happy";
import { barText, sortMeetings, whenLabel } from "./logic";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const meeting = (id: string, status: Meeting["status"], startMs?: number): Meeting => ({ id, title: id, status, startMs, participants: 0 });

describe("whenLabel", () => {
  it("speaks in minutes and hours, before and after", () => {
    expect(whenLabel(NOW + 9 * MIN, NOW)).toBe("in 9 min");
    expect(whenLabel(NOW + 125 * MIN, NOW)).toBe("in 2 h 5 min");
    expect(whenLabel(NOW + 120 * MIN, NOW)).toBe("in 2 h");
    expect(whenLabel(NOW - 3 * MIN, NOW)).toBe("3 min ago");
    expect(whenLabel(NOW + 10_000, NOW)).toBe("now");
    expect(whenLabel(undefined, NOW)).toBe("");
  });
});

describe("meetings", () => {
  const list = [meeting("late", "scheduled", NOW + 180 * MIN), meeting("live", "live", NOW - 10 * MIN), meeting("soon", "scheduled", NOW + 10 * MIN)];
  it("splits into live and upcoming, soonest first", () => {
    const { live, upcoming } = sortMeetings(list);
    expect(live.map((m) => m.id)).toEqual(["live"]);
    expect(upcoming.map((m) => m.id)).toEqual(["soon", "late"]);
  });
  it("points the status bar at a live meeting, else one starting within 15 minutes", () => {
    expect(relevantMeeting({ meetings: list, stale: false }, NOW)?.id).toBe("live");
    expect(relevantMeeting({ meetings: [list[0], list[2]], stale: false }, NOW)?.id).toBe("soon");
    expect(relevantMeeting({ meetings: [list[0]], stale: false }, NOW)).toBeUndefined();
    expect(relevantMeeting({ meetings: [], stale: false }, NOW)).toBeUndefined();
  });
  it("words the status item", () => {
    expect(barText(list[1], NOW)).toBe("live is live");
    expect(barText(list[2], NOW)).toBe("soon in 10 min");
  });
});
