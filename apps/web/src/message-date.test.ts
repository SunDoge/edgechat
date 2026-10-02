import { describe, expect, it } from "vitest";
import { messageDateLabel, messageDateValue, millisecondsUntilNextLocalDay, roomActivityTimeLabel, startsNewMessageDay } from "./message-date";

function localTime(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime();
}

describe("message date presentation", () => {
  it("groups messages by the device's local calendar day", () => {
    expect(startsNewMessageDay(localTime(2026, 10, 3), undefined)).toBe(true);
    expect(startsNewMessageDay(localTime(2026, 10, 3, 23), localTime(2026, 10, 3, 1))).toBe(false);
    expect(startsNewMessageDay(localTime(2026, 10, 4, 0), localTime(2026, 10, 3, 23))).toBe(true);
  });

  it("uses concise relative labels only for today and yesterday", () => {
    const now = localTime(2026, 10, 3);
    expect(messageDateLabel(localTime(2026, 10, 3), now)).toBe("今天");
    expect(messageDateLabel(localTime(2026, 10, 2), now)).toBe("昨天");
    expect(messageDateLabel(localTime(2025, 10, 3), now)).toContain("2025");
  });

  it("emits a machine-readable local calendar date", () => {
    expect(messageDateValue(localTime(2026, 10, 3))).toBe("2026-10-03");
  });

  it("keeps conversation activity times compact", () => {
    const now = localTime(2026, 10, 3, 12);
    expect(roomActivityTimeLabel(new Date(2026, 9, 3, 9, 5).getTime(), now)).toBe("09:05");
    expect(roomActivityTimeLabel(localTime(2026, 10, 2), now)).toBe("昨天");
    expect(roomActivityTimeLabel(localTime(2026, 9, 20), now)).toBe("9月20日");
    expect(roomActivityTimeLabel(localTime(2025, 9, 20), now)).toBe("2025/9/20");
  });

  it("schedules relative-label refresh just after the next local midnight", () => {
    expect(millisecondsUntilNextLocalDay(localTime(2026, 10, 3, 23))).toBeGreaterThan(3_600_000);
    expect(millisecondsUntilNextLocalDay(localTime(2026, 10, 3, 23))).toBeLessThan(3_601_000);
  });
});
