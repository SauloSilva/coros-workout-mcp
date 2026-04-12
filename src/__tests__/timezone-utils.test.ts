import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDatePtBr,
  formatTimePtBr,
  getCorosTimeZone,
  resetCorosTimeZoneCache,
  shiftYmdCalendar,
  weekMondayYmdFromYmd,
  ymdInZone,
} from "../timezone-utils.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetCorosTimeZoneCache();
});

describe("timezone-utils", () => {
  it("ymdInZone matches calendar day in the given zone", () => {
    const instant = new Date("2026-04-12T12:00:00.000Z");
    expect(ymdInZone(instant, "UTC")).toBe("20260412");
    expect(ymdInZone(instant, "America/Sao_Paulo")).toBe("20260412");
  });

  it("shiftYmdCalendar moves by whole calendar days", () => {
    expect(shiftYmdCalendar("20260101", -1)).toBe("20251231");
    expect(shiftYmdCalendar("20251231", 1)).toBe("20260101");
    expect(shiftYmdCalendar("20260412", -30)).toBe("20260313");
  });

  it("weekMondayYmdFromYmd returns Monday (UTC calendar) of that week", () => {
    expect(weekMondayYmdFromYmd("20260413")).toBe("20260413");
    expect(weekMondayYmdFromYmd("20260414")).toBe("20260413");
    expect(weekMondayYmdFromYmd("20260412")).toBe("20260406");
  });

  it("formatDatePtBr differs between UTC and America/Sao_Paulo at UTC midnight", () => {
    const epochSeconds = 1735689600;
    expect(formatDatePtBr(epochSeconds, "UTC")).toBe("01/01/2025");
    expect(formatDatePtBr(epochSeconds, "America/Sao_Paulo")).toBe("31/12/2024");
  });

  it("formatTimePtBr respects time zone", () => {
    const epochSeconds = 1735689600;
    const utc = formatTimePtBr(epochSeconds, "UTC");
    const sp = formatTimePtBr(epochSeconds, "America/Sao_Paulo");
    expect(utc).not.toBe(sp);
  });

  describe("getCorosTimeZone", () => {
    it("prefers COROS_TIMEZONE when valid", () => {
      vi.stubEnv("COROS_TIMEZONE", "America/Sao_Paulo");
      vi.stubEnv("TZ", "UTC");
      expect(getCorosTimeZone()).toBe("America/Sao_Paulo");
    });

    it("falls back to TZ when COROS_TIMEZONE invalid", () => {
      vi.stubEnv("COROS_TIMEZONE", "Not/A_Real_Zone");
      vi.stubEnv("TZ", "Europe/Lisbon");
      resetCorosTimeZoneCache();
      expect(getCorosTimeZone()).toBe("Europe/Lisbon");
    });
  });
});
