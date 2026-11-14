/**
 * src/pipeline/context.ts
 * Assembles runtime context for a conversation turn: temporal anchoring via injectable Clock,
 * timezone resolution, natural language date interval resolution, and past turn retrieval.
 */

import type { Clock } from "../time/clock.js";
import { defaultClock } from "../time/clock.js";
import { resolveAllDateRanges } from "../time/resolver.js";
import { getTurnsByDateRange, getMessagesBySession, searchHistory } from "../memory/ledger.js";
import type { Turn, TurnContext } from "./types.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export type { TurnContext };

export interface AssembleContextOptions {
  sessionId: string;
  userMessage: string;
  timezone?: string;
  clock?: Clock;
}

/**
 * Builds the complete temporal and conversational context for the current turn.
 */
export async function assembleContext(opts: AssembleContextOptions): Promise<TurnContext> {
  const clock = opts.clock ?? defaultClock;
  const timezone = opts.timezone || config.DEFAULT_TIMEZONE;
  const now = clock.now();
  const nowIso = clock.toISOString();
  const nowDt = clock.getDateTime(timezone);
  const nowFormatted = nowDt.toFormat("cccc, dd LLL yyyy HH:mm:ss");

  logger.debug({ sessionId: opts.sessionId, timezone, nowIso }, "Assembling turn context");

  // 1. Resolve any temporal expressions in the user message
  const resolvedDates = resolveAllDateRanges(opts.userMessage, {
    referenceDate: now,
    timezone,
  });

  // 2. Fetch past turns if a date range was resolved
  let pastTurns: Turn[] = [];
  if (resolvedDates.length > 0) {
    const primary = resolvedDates[0];
    logger.info(
      { dateText: primary.text, start: primary.startIso, end: primary.endIso },
      "Resolved relative date range for turn"
    );
    // Look in current session first, fallback to all historical turns (e.g. seeded demo turns)
    pastTurns = getTurnsByDateRange(primary.startIso, primary.endIso, opts.sessionId);
    if (pastTurns.length === 0) {
      pastTurns = getTurnsByDateRange(primary.startIso, primary.endIso);
    }
  }

  // 3. Fallback or augment with FTS5 search or general historical query if user asks about past topics
  if (
    pastTurns.length === 0 &&
    (opts.userMessage.toLowerCase().includes("did i ask") ||
      opts.userMessage.toLowerCase().includes("what did i") ||
      opts.userMessage.toLowerCase().includes("we discuss") ||
      opts.userMessage.toLowerCase().includes("first chat") ||
      opts.userMessage.toLowerCase().includes("past discussion"))
  ) {
    const ftsResults = searchHistory(opts.userMessage, undefined, 3);
    logger.debug({ ftsMatches: ftsResults.length }, "Queried FTS history for memory match");
  }

  // 4. Load recent raw message transcript for the session
  const recentMessages = getMessagesBySession(opts.sessionId, 10);

  return {
    sessionId: opts.sessionId,
    userMessage: opts.userMessage,
    timezone,
    now,
    nowIso,
    nowFormatted,
    resolvedDates,
    pastTurns,
    recentMessages,
  };
}
