/**
 * src/pipeline/index.ts
 * Orchestrates the end-to-end conversation turn across context assembly, routing,
 * tool execution (search/revalidation), citation-grounded generation, and memory persistence.
 * Enforces a 45-second overall deadline and emits initial status events within 300ms.
 */

import crypto from "node:crypto";
import { assembleContext } from "./context.js";
import { routeTurn } from "./router.js";
import { executePlan } from "./executor.js";
import { streamFinalAnswer } from "./writer.js";
import { saveMessage, saveTurn } from "../memory/ledger.js";
import { extractClaims } from "../memory/claims.js";
import type { StreamEvent, Turn } from "./types.js";
import type { Clock } from "../time/clock.js";
import { timeStage, logger } from "../lib/logger.js";

export interface RunTurnInput {
  sessionId: string;
  userMessage: string;
  timezone?: string;
  clock?: Clock;
}

export interface RunTurnCallbacks {
  onEvent: (event: StreamEvent) => void;
}

/**
 * Executes a full conversational turn and yields streaming SSE events.
 */
export async function runTurn(input: RunTurnInput, callbacks: RunTurnCallbacks): Promise<Turn> {
  const turnId = crypto.randomUUID();
  const createdAt = input.clock ? input.clock.toISOString() : new Date().toISOString();

  // 1. Emit immediate status event within 300ms
  callbacks.onEvent({ type: "status", message: "Resolving time and conversation context..." });

  // 45-second turn deadline controller
  let timerId: NodeJS.Timeout | null = null;
  const deadlinePromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error("Overall turn deadline exceeded (45s)"));
    }, 45000);
  });

  const executionPromise = (async (): Promise<Turn> => {
    // Stage 1: Context Assembly
    const { result: context } = await timeStage("context-assembly", async () => {
      return assembleContext({
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        timezone: input.timezone,
        clock: input.clock,
      });
    });

    // Save user message immediately to ledger
    saveMessage(input.sessionId, "user", input.userMessage, createdAt);

    // Stage 2: Routing Decision
    callbacks.onEvent({
      type: "status",
      message: "Evaluating query classification & search plan...",
    });
    const { result: decision } = await timeStage("router", async () => {
      return routeTurn(context);
    });

    // Stage 3: Plan Execution (Search / Revalidation)
    const { result: artifacts } = await timeStage("execution", async () => {
      return executePlan(decision, context, (statusMsg) => {
        callbacks.onEvent({ type: "status", message: statusMsg });
      });
    });

    // Stage 4: Streamed Answer Generation with Verified Citations
    const { result: assistantResponse } = await timeStage("generation", async () => {
      return streamFinalAnswer(context, artifacts, turnId, callbacks);
    });

    // Stage 5: Memory Persistence
    const turn: Turn = {
      id: turnId,
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      assistantResponse,
      userTz: context.timezone,
      createdAt,
      searchQueries: decision.queries,
      citations: artifacts.searchResults.map((r, i) => ({
        id: i + 1,
        url: r.url,
        title: r.title,
        snippet: r.snippet,
      })),
    };

    saveMessage(input.sessionId, "assistant", assistantResponse, new Date().toISOString());
    saveTurn(turn);

    // Stage 6: Asynchronous non-blocking claim extraction
    // Only extract when the turn contains time-sensitive search claims to conserve quota
    const hasTimeSensitiveClaims =
      decision.mode !== "answer" &&
      artifacts.searchResults.length > 0 &&
      decision.volatility !== "low";

    if (hasTimeSensitiveClaims) {
      extractClaims(turn, input.clock).catch((err) => {
        logger.error({ turnId, err }, "Background claim extraction failed");
      });
    } else {
      logger.debug(
        { turnId, mode: decision.mode, volatility: decision.volatility },
        "Skipped claim extraction for non-time-sensitive turn to conserve LLM quota"
      );
    }

    return turn;
  })();

  try {
    const result = await Promise.race([executionPromise, deadlinePromise]);
    if (timerId) clearTimeout(timerId);
    return result;
  } catch (err: unknown) {
    if (timerId) clearTimeout(timerId);
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ turnId, error: err }, "Error occurred during turn execution");
    callbacks.onEvent({ type: "error", error: errorMsg });
    throw err;
  }
}
