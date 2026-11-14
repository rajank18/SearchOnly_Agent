/**
 * src/time/clock.ts
 * Provides injectable Clock abstractions (SystemClock and FakeClock)
 * so timestamps and relative-time operations can be deterministically tested.
 */

import { DateTime } from "luxon";

export interface Clock {
  /** Returns the current date */
  now(): Date;
  /** Returns the ISO-8601 string representation of now in UTC */
  toISOString(): string;
  /** Returns a Luxon DateTime object representing now in the specified timezone */
  getDateTime(zone?: string): DateTime;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  toISOString(): string {
    return this.now().toISOString();
  }

  getDateTime(zone: string = "UTC"): DateTime {
    return DateTime.now().setZone(zone);
  }
}

export class FakeClock implements Clock {
  private currentTime: Date;

  constructor(initialTime: Date | string = new Date()) {
    this.currentTime =
      typeof initialTime === "string" ? new Date(initialTime) : new Date(initialTime);
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  toISOString(): string {
    return this.currentTime.toISOString();
  }

  getDateTime(zone: string = "UTC"): DateTime {
    return DateTime.fromJSDate(this.currentTime, { zone });
  }

  /**
   * Sets the fake clock's current time.
   */
  setTime(time: Date | string): void {
    this.currentTime = typeof time === "string" ? new Date(time) : new Date(time);
  }

  /**
   * Advances the fake clock by milliseconds.
   */
  advanceBy(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }
}

export const defaultClock: Clock = new SystemClock();
