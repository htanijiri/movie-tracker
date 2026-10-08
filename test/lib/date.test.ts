import { describe, expect, it } from "vitest";

import {
  formatMonthDay,
  formatYmd,
  isValidYmd,
  todayInTokyo,
  yearOf,
} from "~/lib/date";

describe("日付の扱い", () => {
  it("「今日」は日本時間で計算する（UTC では前日でも、日本では当日）", () => {
    // UTC 2026-01-09 15:00 は、日本時間の 2026-01-10 00:00。
    expect(todayInTokyo(new Date("2026-01-09T15:00:00Z"))).toBe("2026-01-10");
    expect(todayInTokyo(new Date("2026-01-09T14:59:59Z"))).toBe("2026-01-09");
  });

  it("実在する YYYY-MM-DD だけを正しい日付とみなす", () => {
    expect(isValidYmd("2026-01-10")).toBe(true);
    expect(isValidYmd("2024-02-29")).toBe(true);
    expect(isValidYmd("2026-02-29")).toBe(false);
    expect(isValidYmd("2026-13-01")).toBe(false);
    expect(isValidYmd("2026/01/10")).toBe(false);
    expect(isValidYmd("2026-1-10")).toBe(false);
    expect(isValidYmd("")).toBe(false);
  });

  it("表示用に整形する", () => {
    expect(formatYmd("2026-01-10")).toBe("2026/01/10");
    expect(formatYmd(null)).toBe("");
    expect(formatYmd("不正")).toBe("");
    expect(formatMonthDay("2026-01-05")).toBe("1月5日");
    expect(yearOf("2026-01-05")).toBe("2026");
    expect(yearOf("")).toBe("");
  });
});
