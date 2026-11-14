/**
 * src/pipeline/router.ts
 * Uses the fast LLM with generateObject to classify execution mode (answer | search | revalidate),
 * formulate optimized search queries, identify key entities, and determine factual volatility.
 * Falls back to an intelligent heuristic if the LLM fails or times out after 3 seconds.
 */

import { generateObject } from "ai";
import { z } from "zod";
import type { RouterDecision, TurnContext } from "./types.js";
import { getFastModel } from "../llm/models.js";
import { ROUTER_SYSTEM_PROMPT, buildRouterUserPrompt } from "../prompts/router.js";
import { logger } from "../lib/logger.js";

const routerSchema = z.object({
  mode: z.enum(["answer", "search", "revalidate"]),
  queries: z.array(z.string()).max(5).describe("Max 5 targeted search queries, each <= 8 words"),
  entities: z
    .array(z.string())
    .describe("Specific named products, organizations, or tools mentioned"),
  volatility: z.enum(["high", "medium", "low"]),
  rationale: z.string().optional(),
  referencedRange: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .optional(),
});

/**
 * Deterministic heuristic fallback used when fast LLM fails or times out (3s).
 */
export function heuristicRoute(context: TurnContext): RouterDecision {
  const lower = context.userMessage.toLowerCase();

  // 1. Revalidation checks: explicit questions about change since a past date/state
  const isRevalidate =
    (lower.includes("changed") ||
      lower.includes("still") ||
      lower.includes("updated") ||
      lower.includes("difference")) &&
    (lower.includes("since") ||
      lower.includes("last") ||
      lower.includes("previous") ||
      lower.includes("monday") ||
      lower.includes("yesterday") ||
      context.pastTurns.length > 0);

  if (isRevalidate) {
    const entities = extractSimpleEntities(context.userMessage);
    const range = context.resolvedDates[0]
      ? { start: context.resolvedDates[0].startIso, end: context.resolvedDates[0].endIso }
      : undefined;

    return {
      mode: "revalidate",
      queries:
        entities.length > 0
          ? entities.map((e) => `${e} pricing changelog ${context.now.getFullYear()}`)
          : [context.userMessage],
      entities,
      volatility: "high",
      rationale: "Heuristic: detected change-detection request across time/past turns",
      referencedRange: range,
    };
  }

  // 2. Pure recall from history or self-contained queries
  const isHistoryQuery =
    lower.includes("what did i ask") ||
    lower.includes("what did we discuss") ||
    lower.includes("did i ask") ||
    lower.includes("my previous question") ||
    lower.includes("first chat") ||
    lower.includes("first message") ||
    lower.includes("what is my name") ||
    lower.includes("what's my name") ||
    lower.includes("what did you reply") ||
    lower.includes("what did u reply") ||
    lower.includes("what did you say") ||
    lower.includes("what did u say") ||
    (context.recentMessages.length > 0 &&
      (lower.includes("earlier") ||
        lower.includes("previously") ||
        lower.includes("you said") ||
        lower.includes("i said"))) ||
    (context.resolvedDates.length > 0 &&
      context.pastTurns.length > 0 &&
      !lower.includes("price") &&
      !lower.includes("latest"));

  // 3. Chit-chat / conversational checks
  const isChitChat =
    /^(hi|hello|hey|greetings|howdy|good\s+(morning|afternoon|evening))/i.test(lower) ||
    lower.includes("how can you help") ||
    lower.includes("what can you do") ||
    lower.includes("who are you") ||
    /^(thanks|thank you)[.!?]?$/i.test(lower.trim());

  if (isHistoryQuery || isChitChat) {
    const range = context.resolvedDates[0]
      ? { start: context.resolvedDates[0].startIso, end: context.resolvedDates[0].endIso }
      : undefined;
    return {
      mode: "answer",
      queries: [],
      entities: extractSimpleEntities(context.userMessage),
      volatility: "low",
      rationale: isHistoryQuery
        ? "Heuristic: answerable from conversation history"
        : "Heuristic: conversational chit-chat",
      referencedRange: range,
    };
  }

  // 4. External facts / search
  const entities = extractSimpleEntities(context.userMessage);
  const currentYear = context.now.getFullYear();
  let query = context.userMessage.replace(/[?.,!]/g, "").trim();
  if (!query.includes(String(currentYear))) {
    query = `${query} ${currentYear}`;
  }

  return {
    mode: "search",
    queries: [query.slice(0, 80)],
    entities,
    volatility: lower.includes("price") || lower.includes("cost") ? "high" : "medium",
    rationale: "Heuristic: external facts or pricing query",
  };
}

function extractSimpleEntities(text: string): string[] {
  const common = [
    "hubspot",
    "postgresql",
    "postgres",
    "vite",
    "react",
    "supabase",
    "neon",
    "aws",
    "tavily",
    "exa",
    "groq",
    "openai",
    "gemini",
    "pipedrive",
    "salesforce",
  ];
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const item of common) {
    if (lower.includes(item)) {
      found.push(item.charAt(0).toUpperCase() + item.slice(1));
    }
  }
  return found;
}

/**
 * Classifies the incoming turn and determines whether web search or revalidation is necessary.
 */
export async function routeTurn(context: TurnContext): Promise<RouterDecision> {
  logger.debug({ userMessage: context.userMessage }, "Routing turn with fast LLM");

  const pastTurnsSummary = context.pastTurns
    .map(
      (t) =>
        `[${t.createdAt}] User: "${t.userMessage}" -> Assistant: "${t.assistantResponse.slice(0, 140)}..."`
    )
    .join("\n");

  const userPrompt = buildRouterUserPrompt(context.userMessage, {
    nowFormatted: context.nowFormatted,
    resolvedDates: context.resolvedDates.map((d) => ({
      text: d.text,
      startIso: d.startIso,
      endIso: d.endIso,
    })),
    pastTurnsSummary: pastTurnsSummary || undefined,
  });

  try {
    const fastModel = getFastModel();
    const abortSignal = AbortSignal.timeout(3000);

    const result = await generateObject({
      model: fastModel,
      schema: routerSchema,
      system: ROUTER_SYSTEM_PROMPT,
      prompt: userPrompt,
      abortSignal,
    });

    const decision: RouterDecision = {
      mode: result.object.mode,
      queries: result.object.queries.slice(0, 5),
      entities: result.object.entities,
      volatility: result.object.volatility,
      rationale: result.object.rationale,
      referencedRange: result.object.referencedRange,
    };

    logger.info(
      { mode: decision.mode, queryCount: decision.queries.length, entities: decision.entities },
      "Fast LLM routing decision obtained"
    );

    return decision;
  } catch (error) {
    logger.warn({ error }, "Fast LLM routing failed or timed out (3s); using heuristic router");
    return heuristicRoute(context);
  }
}
