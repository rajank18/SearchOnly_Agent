/**
 * src/time/resolver.ts
 * Wraps chrono-node to resolve natural language date/time expressions
 * (e.g. "yesterday", "last Tuesday", "on Monday", "3 Nov") into concrete UTC/timezone-bounded intervals.
 */

import * as chrono from "chrono-node";
import { DateTime } from "luxon";

export interface ResolvedDateRange {
  /** The natural language snippet that was resolved */
  text: string;
  /** Start datetime in user's timezone */
  start: DateTime;
  /** End datetime in user's timezone */
  end: DateTime;
  /** Start time in ISO-8601 UTC */
  startIso: string;
  /** End time in ISO-8601 UTC */
  endIso: string;
  /** The timezone used for interpretation */
  timezone: string;
}

export interface ResolverOptions {
  referenceDate?: Date;
  timezone?: string;
}

/**
 * Resolves all date expressions found in the input text into timezone-bounded intervals.
 */
export function resolveAllDateRanges(
  text: string,
  options: ResolverOptions = {}
): ResolvedDateRange[] {
  const tz = options.timezone || "UTC";
  const refDate = options.referenceDate || new Date();

  // Parse using chrono with the given reference instant
  const parsedResults = chrono.parse(text, {
    instant: refDate,
    timezone: tz,
  });

  const resolved: ResolvedDateRange[] = [];

  for (const item of parsedResults) {
    const s = item.start;
    const year = s.get("year");
    const month = s.get("month");
    const day = s.get("day");

    if (year === null || month === null || day === null) {
      continue;
    }

    const hasTime = s.isCertain("hour");
    let startDt: DateTime;
    let endDt: DateTime;

    if (hasTime) {
      startDt = DateTime.fromObject(
        {
          year,
          month,
          day,
          hour: s.get("hour") ?? 0,
          minute: s.get("minute") ?? 0,
          second: s.get("second") ?? 0,
        },
        { zone: tz }
      );
    } else {
      startDt = DateTime.fromObject({ year, month, day }, { zone: tz }).startOf("day");
    }

    if (item.end) {
      const e = item.end;
      const eYear = e.get("year") ?? year;
      const eMonth = e.get("month") ?? month;
      const eDay = e.get("day") ?? day;
      const eHasTime = e.isCertain("hour");

      if (eHasTime) {
        endDt = DateTime.fromObject(
          {
            year: eYear,
            month: eMonth,
            day: eDay,
            hour: e.get("hour") ?? 23,
            minute: e.get("minute") ?? 59,
            second: e.get("second") ?? 59,
          },
          { zone: tz }
        );
      } else {
        endDt = DateTime.fromObject({ year: eYear, month: eMonth, day: eDay }, { zone: tz }).endOf(
          "day"
        );
      }
    } else {
      if (hasTime) {
        endDt = startDt.plus({ hours: 1 });
      } else {
        endDt = startDt.endOf("day");
      }
    }

    resolved.push({
      text: item.text,
      start: startDt,
      end: endDt,
      startIso: startDt.toUTC().toISO() ?? startDt.toISO() ?? "",
      endIso: endDt.toUTC().toISO() ?? endDt.toISO() ?? "",
      timezone: tz,
    });
  }

  return resolved;
}

/**
 * Resolves the primary/first date expression found in text, or returns null if none found.
 */
export function resolveDateRange(
  text: string,
  options: ResolverOptions = {}
): ResolvedDateRange | null {
  const all = resolveAllDateRanges(text, options);
  return all.length > 0 ? all[0] : null;
}
