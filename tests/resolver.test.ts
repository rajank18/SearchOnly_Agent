/**
 * tests/resolver.test.ts
 * Unit tests verifying natural language date resolution for required expressions:
 * "yesterday", "last Tuesday", "on Monday", "3 November", and "3 Nov".
 */

import { describe, it, expect } from "vitest";
import { resolveDateRange } from "../src/time/resolver.js";
import { DateTime } from "luxon";

describe("time/resolver", () => {
  // Fixed reference date: Saturday, November 14, 2026, 12:00:00 in Asia/Kolkata
  const tz = "Asia/Kolkata";
  const refDateTime = DateTime.fromISO("2026-11-14T12:00:00", { zone: tz });
  const referenceDate = refDateTime.toJSDate();

  it("resolves 'yesterday' to the preceding calendar day", () => {
    const res = resolveDateRange("What were the sales yesterday?", {
      referenceDate,
      timezone: tz,
    });

    expect(res).not.toBeNull();
    expect(res?.start.toISODate()).toBe("2026-11-13");
    expect(res?.end.toISODate()).toBe("2026-11-13");
    expect(res?.start.hour).toBe(0);
    expect(res?.end.hour).toBe(23);
  });

  it("resolves 'last Tuesday' to the previous Tuesday", () => {
    // Nov 14, 2026 is Saturday. Last Tuesday was Nov 10, 2026.
    const res = resolveDateRange("Show me the report from last Tuesday", {
      referenceDate,
      timezone: tz,
    });

    expect(res).not.toBeNull();
    expect(res?.start.toISODate()).toBe("2026-11-10");
    expect(res?.start.weekday).toBe(2); // Tuesday in Luxon is 2
  });

  it("resolves 'on Monday' to a Monday", () => {
    const res = resolveDateRange("What did the user ask on Monday?", {
      referenceDate,
      timezone: tz,
    });

    expect(res).not.toBeNull();
    expect(res?.start.weekday).toBe(1); // Monday in Luxon is 1
  });

  it("resolves '3 November' to November 3rd of the reference year", () => {
    const res = resolveDateRange("Check emails from 3 November", {
      referenceDate,
      timezone: tz,
    });

    expect(res).not.toBeNull();
    expect(res?.start.year).toBe(2026);
    expect(res?.start.month).toBe(11);
    expect(res?.start.day).toBe(3);
    expect(res?.start.toISODate()).toBe("2026-11-03");
  });

  it("resolves '3 Nov' to November 3rd identical to '3 November'", () => {
    const res = resolveDateRange("What happened on 3 Nov?", {
      referenceDate,
      timezone: tz,
    });

    expect(res).not.toBeNull();
    expect(res?.start.year).toBe(2026);
    expect(res?.start.month).toBe(11);
    expect(res?.start.day).toBe(3);
    expect(res?.start.toISODate()).toBe("2026-11-03");
  });

  it("returns null when no date expression is present", () => {
    const res = resolveDateRange("Tell me about quantum computing", {
      referenceDate,
      timezone: tz,
    });

    expect(res).toBeNull();
  });
});
